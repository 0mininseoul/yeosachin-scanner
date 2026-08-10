"""Create a local instagrapi session with resumable device state.

This helper deliberately keeps the username/password prompt local and never
prints the resulting session. If Instagram requests an official app/web
approval, the same client settings are saved before the process exits so the
next invocation can resume with the same device identifiers.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import tempfile
from pathlib import Path
from typing import Any


DEFAULT_OUTPUT = Path('/tmp/instagram-session-settings.b64')
DEFAULT_STATE = Path('/tmp/instagram-session-bootstrap-settings.json')
CHALLENGE_EXCEPTION_NAMES = {
    'ChallengeRequired',
    'ChallengeUnknownStep',
    'CheckpointRequired',
    'ConsentRequired',
}


class SessionAccountMismatchError(RuntimeError):
    pass


def _secure_dump(client: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f'.{path.name}.tmp-', dir=path.parent,
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        client.dump_settings(temporary)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _contains_password_material(value: Any) -> bool:
    if isinstance(value, dict):
        return any(
            'password' in str(key).lower() or _contains_password_material(child)
            for key, child in value.items()
        )
    if isinstance(value, list):
        return any(_contains_password_material(child) for child in value)
    return False


def _safe_settings(settings: Any) -> dict[str, Any]:
    if not isinstance(settings, dict) or _contains_password_material(settings):
        raise RuntimeError('A password-free persisted session was not returned.')
    authorization_data = settings.get('authorization_data')
    device_settings = settings.get('device_settings')
    if (
        not isinstance(authorization_data, dict)
        or not isinstance(authorization_data.get('sessionid'), str)
        or not authorization_data.get('sessionid')
        or not isinstance(device_settings, dict)
    ):
        raise RuntimeError('A complete persisted session was not returned.')
    return dict(settings)


def _write_output(settings: dict[str, Any], output_path: Path) -> None:
    payload = json.dumps(settings, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
    encoded = base64.b64encode(payload)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f'.{output_path.name}.tmp-', dir=output_path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(encoded)
        os.replace(temporary, output_path)
        os.chmod(output_path, 0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--state-path',
        type=Path,
        default=Path(os.environ.get('IG_BOOTSTRAP_STATE_PATH', DEFAULT_STATE)),
        help='local state file reused across an official approval retry',
    )
    parser.add_argument(
        '--output-path',
        type=Path,
        default=Path(os.environ.get('IG_SESSION_OUTPUT_PATH', DEFAULT_OUTPUT)),
        help='local base64 output file written only after a successful login',
    )
    return parser


def main(argv: list[str] | None = None) -> None:
    args = _parser().parse_args(argv)
    from instagrapi import Client

    username = input('Instagram username: ').strip()
    password = getpass.getpass('Instagram password (hidden): ')
    verification_code = getpass.getpass(
        'Current 2FA code (hidden; press Enter if disabled): '
    ).strip()
    if not username or not password:
        raise SystemExit('Username and password are required.')
    if args.output_path.exists() or args.output_path.is_symlink():
        raise SystemExit(
            'Session output already exists. Move or remove it, or choose a new '
            '--output-path before starting another bootstrap attempt.'
        )

    client = Client()
    resumed = args.state_path.exists()
    if resumed:
        client.load_settings(args.state_path)
    client.delay_range = [1, 3]

    try:
        _secure_dump(client, args.state_path)
        login_kwargs = {'verification_code': verification_code} if verification_code else {}
        if not client.login(username, password, **login_kwargs):
            raise RuntimeError('Instagram login did not complete.')
        account = client.account_info()
        authenticated_username = getattr(account, 'username', None)
        if (
            not isinstance(authenticated_username, str)
            or authenticated_username.strip().lower() != username.lower()
        ):
            raise SessionAccountMismatchError(
                'The saved session belongs to a different Instagram account. '
                'Use a separate state path for each account.'
            )
        _secure_dump(client, args.state_path)
        _write_output(_safe_settings(client.get_settings()), args.output_path)
    except Exception as error:
        if isinstance(error, SessionAccountMismatchError):
            raise SystemExit(str(error)) from None
        try:
            _secure_dump(client, args.state_path)
        except Exception:
            pass
        if type(error).__name__ in CHALLENGE_EXCEPTION_NAMES:
            action = 'resume' if resumed else 'retry'
            raise SystemExit(
                'Instagram requires official app/web approval. Complete that approval '
                f'on the trusted device, then rerun this command to {action} with the '
                f'same saved client state: {args.state_path}'
            ) from None
        raise

    print('Session created locally. No credential or session value was printed.')
    print(f'Bootstrap state retained at {args.state_path}.')


if __name__ == '__main__':
    main()
