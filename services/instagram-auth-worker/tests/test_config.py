import base64
import json
import unittest

from app.config import WorkerConfig


def encoded_settings(extra=None):
    value = {
        'authorization_data': {'sessionid': 'session-value'},
        'device_settings': {'android_version': 35, 'device_id': 'stable-device'},
        **(extra or {}),
    }
    return base64.b64encode(json.dumps(value).encode()).decode()


class WorkerConfigTest(unittest.TestCase):
    def test_requires_a_persisted_session_and_keeps_single_account_defaults(self):
        with self.assertRaises(ValueError):
            WorkerConfig.from_env({})

        config = WorkerConfig.from_env({
            'IG_SESSION_SETTINGS_BASE64': encoded_settings(),
            'IG_DURABLE_STORE_BUCKET': 'worker-state-bucket',
        })
        self.assertEqual(config.max_in_flight, 5)
        self.assertEqual(config.queue_timeout_seconds, 240)
        self.assertEqual(config.rate_limit_cooldown_seconds, 900)
        self.assertEqual(config.durable_store_bucket, 'worker-state-bucket')
        self.assertEqual(config.durable_store_prefix, 'instagram-auth-worker')
        self.assertEqual(config.session_settings['authorization_data']['sessionid'], 'session-value')

    def test_rejects_password_material_and_invalid_operational_bounds(self):
        with self.assertRaises(ValueError):
            WorkerConfig.from_env({
                'IG_SESSION_SETTINGS_BASE64': encoded_settings({'password': 'must-not-exist'}),
            })
        for key, value in [
            ('IG_MAX_IN_FLIGHT', '6'),
            ('IG_QUEUE_TIMEOUT_SECONDS', '301'),
            ('IG_RATE_LIMIT_COOLDOWN_SECONDS', '59'),
        ]:
            with self.assertRaises(ValueError):
                WorkerConfig.from_env({
                    'IG_SESSION_SETTINGS_BASE64': encoded_settings(),
                    key: value,
                })

    def test_requires_gcs_durable_store_for_non_test_configuration(self):
        with self.assertRaises(ValueError):
            WorkerConfig.from_env({
                'IG_SESSION_SETTINGS_BASE64': encoded_settings(),
            })


if __name__ == '__main__':
    unittest.main()
