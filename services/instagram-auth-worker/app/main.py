import hmac
import re
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, HttpUrl

from .config import WorkerConfig
from .durable import AccountOperationLockedError, GcsDurableStore, DurableStoreError
from .gate import AdmissionGate, QueueFullError, QueueTimeoutError
from .gateway import create_instagrapi_gateway
from .safety import AccountQuarantinedError, AccountSafetyCircuit, SafetyStateUnavailableError
from .service import (
    IdempotencyConflictError,
    IdempotencyPendingError,
    InstagramAuthenticationError,
    InstagramAuthService,
    InstagramChallengeError,
    InstagramRateLimitedError,
    WorkerSchemaError,
)


class WorkerAuthorizationError(RuntimeError):
    pass


class OperationRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    operationKey: str = Field(
        min_length=67,
        max_length=129,
        pattern=r'^[a-z][a-z0-9-]{1,63}:[a-f0-9]{64}$',
    )
    inputHash: str = Field(pattern=r'^[a-f0-9]{64}$')


class RelationshipRequest(OperationRequest):
    username: str = Field(pattern=r'^[a-z0-9._]{1,30}$')
    limit: int = Field(ge=1, le=1_200)


class InteractionRequest(OperationRequest):
    model_config = ConfigDict(extra='forbid', strict=True)
    postUrls: list[HttpUrl] = Field(min_length=1, max_length=10)
    limitPerPost: int = Field(ge=1, le=150)


class ProfileRequest(OperationRequest):
    username: str = Field(pattern=r'^[a-z0-9._]{1,30}$')
    mediaLimit: int = Field(ge=0, le=10)


class ProfileBatchRequest(OperationRequest):
    usernames: list[str] = Field(min_length=1, max_length=30)
    mediaLimit: int = Field(ge=0, le=10)


def error_payload(
    code: str,
    retryable: bool,
    retry_after_seconds: int | None = None,
) -> dict[str, Any]:
    return {
        'schemaVersion': 1,
        'code': code,
        'retryable': retryable,
        **(
            {'retryAfterSeconds': retry_after_seconds}
            if retry_after_seconds is not None else {}
        ),
    }


def create_app(
    injected_service: InstagramAuthService | Any | None = None,
    local_bearer_token: str | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        if injected_service is not None:
            application.state.instagram_service = injected_service
            application.state.local_bearer_token = local_bearer_token
            yield
            return
        config = WorkerConfig.from_env()
        durable_store = GcsDurableStore(
            config.durable_store_bucket, config.durable_store_prefix,
        )
        application.state.instagram_service = InstagramAuthService(
            gateway=create_instagrapi_gateway(config.session_settings),
            gate=AdmissionGate(
                max_in_flight=config.max_in_flight,
                queue_timeout_seconds=config.queue_timeout_seconds,
            ),
            safety=AccountSafetyCircuit(
                config.rate_limit_cooldown_seconds, store=durable_store,
            ),
            ledger_store=durable_store,
        )
        application.state.local_bearer_token = config.local_bearer_token
        yield

    application = FastAPI(
        docs_url=None,
        openapi_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    if injected_service is not None:
        application.state.instagram_service = injected_service
        application.state.local_bearer_token = local_bearer_token

    def strict_error(status: int, code: str, retryable: bool, retry_after=None):
        return JSONResponse(
            status_code=status,
            content=error_payload(code, retryable, retry_after),
        )

    @application.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, _error: RequestValidationError):
        return strict_error(400, 'invalid_request', False)

    @application.exception_handler(ValueError)
    async def value_error(_request: Request, _error: ValueError):
        return strict_error(400, 'invalid_request', False)

    @application.exception_handler(QueueFullError)
    async def queue_full(_request: Request, _error: QueueFullError):
        return strict_error(429, 'queue_full', True, 5)

    @application.exception_handler(QueueTimeoutError)
    async def queue_timeout(_request: Request, _error: QueueTimeoutError):
        return strict_error(503, 'queue_timeout', True, 30)

    @application.exception_handler(AccountOperationLockedError)
    async def account_operation_locked(
        _request: Request, _error: AccountOperationLockedError,
    ):
        return strict_error(423, 'account_operation_locked', False)

    @application.exception_handler(AccountQuarantinedError)
    async def account_quarantined(_request: Request, error: AccountQuarantinedError):
        return strict_error(423, error.code, False, error.retry_after_seconds)

    @application.exception_handler(SafetyStateUnavailableError)
    @application.exception_handler(DurableStoreError)
    async def durable_state_unavailable(_request: Request, _error: RuntimeError):
        return strict_error(503, 'durable_state_unavailable', True, 30)

    @application.exception_handler(IdempotencyPendingError)
    async def idempotency_pending(_request: Request, _error: IdempotencyPendingError):
        return strict_error(409, 'idempotency_pending', False)

    @application.exception_handler(IdempotencyConflictError)
    async def idempotency_conflict(_request: Request, _error: IdempotencyConflictError):
        return strict_error(409, 'idempotency_key_reused', False)

    @application.exception_handler(InstagramRateLimitedError)
    async def instagram_rate_limited(_request: Request, _error: InstagramRateLimitedError):
        return strict_error(
            429,
            'instagram_rate_limited',
            True,
            getattr(_error, 'retry_after_seconds', None),
        )

    @application.exception_handler(InstagramChallengeError)
    async def instagram_challenge(_request: Request, _error: InstagramChallengeError):
        return strict_error(423, 'instagram_challenge', False)

    @application.exception_handler(InstagramAuthenticationError)
    async def instagram_auth(_request: Request, _error: InstagramAuthenticationError):
        return strict_error(423, 'authentication_failed', False)

    @application.exception_handler(WorkerSchemaError)
    async def worker_schema_error(_request: Request, _error: WorkerSchemaError):
        return strict_error(502, 'worker_schema_error', False)

    @application.exception_handler(WorkerAuthorizationError)
    async def worker_auth(_request: Request, _error: WorkerAuthorizationError):
        return strict_error(401, 'authentication_failed', False)

    @application.exception_handler(Exception)
    async def unexpected_error(_request: Request, _error: Exception):
        return strict_error(502, 'upstream_error', True)

    async def authorize(
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> None:
        token = getattr(request.app.state, 'local_bearer_token', local_bearer_token)
        if token is None:
            return
        supplied = authorization.removeprefix('Bearer ') if authorization else ''
        if not supplied or not hmac.compare_digest(supplied, token):
            raise WorkerAuthorizationError()

    def service(request: Request):
        return request.app.state.instagram_service

    @application.get('/healthz')
    async def health():
        return {'schemaVersion': 1, 'status': 'ok'}

    @application.post('/v1/relationships/followers', dependencies=[Depends(authorize)])
    async def followers(payload: RelationshipRequest, request: Request):
        return await service(request).relationship(
            'followers', payload.username, payload.limit,
            payload.operationKey, payload.inputHash,
        )

    @application.post('/v1/relationships/following', dependencies=[Depends(authorize)])
    async def following(payload: RelationshipRequest, request: Request):
        return await service(request).relationship(
            'following', payload.username, payload.limit,
            payload.operationKey, payload.inputHash,
        )

    @application.post('/v1/interactions/likers', dependencies=[Depends(authorize)])
    async def likers(payload: InteractionRequest, request: Request):
        return await service(request).likers(
            [str(value) for value in payload.postUrls],
            payload.limitPerPost,
            payload.operationKey,
            payload.inputHash,
        )

    @application.post('/v1/interactions/comments', dependencies=[Depends(authorize)])
    async def comments(payload: InteractionRequest, request: Request):
        if payload.limitPerPost > 15:
            raise ValueError('comment limit is too high')
        return await service(request).comments(
            [str(value) for value in payload.postUrls],
            payload.limitPerPost,
            payload.operationKey,
            payload.inputHash,
        )

    @application.post('/v1/profiles/profile', dependencies=[Depends(authorize)])
    async def profile(payload: ProfileRequest, request: Request):
        return await service(request).profile(
            payload.username, payload.mediaLimit, payload.operationKey, payload.inputHash,
        )

    @application.post('/v1/profiles', dependencies=[Depends(authorize)])
    async def profiles(payload: ProfileBatchRequest, request: Request):
        if any(not re.fullmatch(r'[a-z0-9._]{1,30}', username) for username in payload.usernames):
            raise ValueError('invalid username')
        if len(set(payload.usernames)) != len(payload.usernames):
            raise ValueError('duplicate usernames')
        return await service(request).profiles(
            payload.usernames, payload.mediaLimit, payload.operationKey, payload.inputHash,
        )

    return application


app = create_app()
