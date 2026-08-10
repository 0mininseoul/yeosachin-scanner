import base64
import importlib.util
import json
import stat
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).parents[3] / 'scripts' / 'bootstrap-instagram-session.py'
SPEC = importlib.util.spec_from_file_location('bootstrap_instagram_session', SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ChallengeRequired(Exception):
    pass


class _FakeClient:
    attempts = 0

    def __init__(self):
        self.settings = {
            'uuids': {'uuid': 'stable-device-uuid'},
            'device_settings': {'model': 'stable-device'},
            'authorization_data': {},
            'cookies': {'csrftoken': 'local-only-test-cookie'},
            'locale': 'ko_KR',
        }
        self.delay_range = None

    def load_settings(self, path):
        self.settings = json.loads(Path(path).read_text())

    def dump_settings(self, path):
        Path(path).write_text(json.dumps(self.settings))
        return True

    def login(self, username, password, **_kwargs):
        type(self).attempts += 1
        if type(self).attempts == 1:
            raise ChallengeRequired('official approval required')
        self.settings['authorization_data'] = {'sessionid': 'local-only-test-session'}
        return True

    def get_settings(self):
        return self.settings

    def account_info(self):
        return types.SimpleNamespace(username='burner')


class BootstrapSessionTests(unittest.TestCase):
    def test_challenge_persists_state_and_next_run_reuses_complete_state(self):
        _FakeClient.attempts = 0
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / 'state.json'
            output_path = Path(directory) / 'session.b64'
            fake_module = types.SimpleNamespace(Client=_FakeClient)
            with (
                patch.dict('sys.modules', {'instagrapi': fake_module}),
                patch('builtins.input', return_value='burner'),
                patch.object(MODULE.getpass, 'getpass', side_effect=['password', '']),
            ):
                with self.assertRaises(SystemExit):
                    MODULE.main(['--state-path', str(state_path), '--output-path', str(output_path)])

            self.assertTrue(state_path.exists())
            self.assertFalse(output_path.exists())
            first_state = json.loads(state_path.read_text())
            self.assertEqual(first_state['uuids']['uuid'], 'stable-device-uuid')
            self.assertEqual(stat.S_IMODE(state_path.stat().st_mode), 0o600)

            with (
                patch.dict('sys.modules', {'instagrapi': fake_module}),
                patch('builtins.input', return_value='burner'),
                patch.object(MODULE.getpass, 'getpass', side_effect=['password', '']),
            ):
                MODULE.main(['--state-path', str(state_path), '--output-path', str(output_path)])

            self.assertEqual(_FakeClient.attempts, 2)
            second_state = json.loads(state_path.read_text())
            self.assertEqual(second_state['uuids']['uuid'], first_state['uuids']['uuid'])
            self.assertEqual(
                json.loads(base64.b64decode(output_path.read_bytes())),
                {
                    **second_state,
                    'authorization_data': {'sessionid': 'local-only-test-session'},
                },
            )
            self.assertEqual(second_state['cookies']['csrftoken'], 'local-only-test-cookie')
            self.assertEqual(stat.S_IMODE(output_path.stat().st_mode), 0o600)

    def test_password_material_is_never_written(self):
        with self.assertRaisesRegex(RuntimeError, 'password-free'):
            MODULE._safe_settings({
                'authorization_data': {'sessionid': 'local-only-test-session'},
                'device_settings': {'model': 'stable-device'},
                'nested': {'password_hint': 'must-not-be-written'},
            })

    def test_resumed_session_must_match_the_entered_username(self):
        _FakeClient.attempts = 1
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / 'state.json'
            output_path = Path(directory) / 'session.b64'
            state_path.write_text(json.dumps(_FakeClient().settings))
            fake_module = types.SimpleNamespace(Client=_FakeClient)
            with (
                patch.dict('sys.modules', {'instagrapi': fake_module}),
                patch('builtins.input', return_value='other.account'),
                patch.object(MODULE.getpass, 'getpass', side_effect=['password', '']),
            ):
                with self.assertRaisesRegex(SystemExit, 'different Instagram account'):
                    MODULE.main(['--state-path', str(state_path), '--output-path', str(output_path)])

            self.assertFalse(output_path.exists())

    def test_existing_output_blocks_a_new_attempt(self):
        _FakeClient.attempts = 0
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / 'state.json'
            output_path = Path(directory) / 'session.b64'
            output_path.write_bytes(b'previous-session-output')
            fake_module = types.SimpleNamespace(Client=_FakeClient)
            with (
                patch.dict('sys.modules', {'instagrapi': fake_module}),
                patch('builtins.input', return_value='burner'),
                patch.object(MODULE.getpass, 'getpass', side_effect=['password', '']),
            ):
                with self.assertRaisesRegex(SystemExit, 'Session output already exists'):
                    MODULE.main(['--state-path', str(state_path), '--output-path', str(output_path)])

            self.assertEqual(_FakeClient.attempts, 0)
            self.assertEqual(output_path.read_bytes(), b'previous-session-output')


if __name__ == '__main__':
    unittest.main()
