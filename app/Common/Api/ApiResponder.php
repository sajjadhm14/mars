<?php

namespace App\Common\Api;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Resources\Json\ResourceCollection;
use Illuminate\Pagination\LengthAwarePaginator;
use Illuminate\Pagination\Paginator;
use Symfony\Component\HttpFoundation\Response;

final class ApiResponder
{
    public const array problem_types = [
        Response::HTTP_INTERNAL_SERVER_ERROR => 'internal-error',
        Response::HTTP_BAD_REQUEST => 'bad-request',
        Response::HTTP_UNAUTHORIZED => 'unauthenticated',
        Response::HTTP_FORBIDDEN => 'forbidden',
        Response::HTTP_UNPROCESSABLE_ENTITY => 'validation-error',
    ];

    public function problemType(string $slug): string
    {
        $appUrl = (string)config('app.url');

        if ($appUrl === '') {
            return 'about:blank';
        }

        return rtrim($appUrl, '/') . '/problems/' . ltrim($slug, '/');
    }

    public function noContent(): JsonResponse
    {
        return new \App\Common\Api\NoContentResponse(['X-Request-Id' => api_request_id()]);
    }

    public function accepted(string $message, mixed $data = null): JsonResponse
    {
        return $this->success(
            message: $message,
            data: $data,
            status: Response::HTTP_ACCEPTED,
        );
    }

    public function created(string $message, mixed $data): JsonResponse
    {
        return $this->success(
            message: $message,
            data: $data,
            status: Response::HTTP_CREATED,
        );
    }

    public function successData(mixed $data = null, int $status = Response::HTTP_OK): JsonResponse
    {
        return $this->success(
            message: __('The action was executed successfully.'),
            data: $data,
            status: $status,
        );
    }

    public function success(string $message, mixed $data = null, int $status = Response::HTTP_OK): JsonResponse
    {
        $requestId = api_request_id();
        $serverTime = now()->toISOString();

        $result = $data;
        $pagination = null;

        if ($data instanceof ResourceCollection) {
            $payload = $data->response()->getData(true);
            $result = $payload['data'] ?? null;
            $pagination = $this->paginationFromResourceCollectionPayload($payload);
        } elseif ($data instanceof LengthAwarePaginator) {
            $result = $data->items();
            $pagination = $this->paginationFromLengthAwarePaginator($data);
        } elseif ($data instanceof Paginator) {
            $result = $data->items();
            $pagination = $this->paginationFromPaginator($data);
        }

        $body = [
            'data' => $result,
            'meta' => array_filter([
                'message' => $message,
                'requestId' => $requestId,
                'serverTime' => $serverTime,
                'pagination' => $pagination,
            ], static fn ($v) => !is_null($v)),
        ];

        return response()
            ->json($body, $status)
            ->header('X-Request-Id', $requestId);
    }

    /**
     * Error (RFC7807 - Problem Details)
     * Content-Type: application/problem+json
     *
     * @param array<string, mixed> $extra
     * @param array<string, string> $headers
     */
    public function problem(
        int $status,
        string $title,
        string|null $detail = null,
        int|null $appCode = null,
        string|null $type = null,
        array $extra = [],
        array $headers = [],
        Throwable|null $exception = null,
    ): JsonResponse {
        $requestId = api_request_id();
        $serverTime = now()->toISOString();

        $body = array_merge([
            'type' => $type ?? 'about:blank',
            'title' => $title,
            //            'status' => $status,
            'detail' => $detail ?? $title,
            'instance' => request()->getRequestUri(),
            'code' => $appCode ?? $status,
            'requestId' => $requestId,
            'serverTime' => $serverTime,
        ], $extra);

        if (config('app.debug')) {
            $body['trace'] = $exception?->getTrace() ?? debug_backtrace();

            if ($exception !== null) {
                $body['exception'] = [
                    'type' => get_class($exception),
                    'message' => $exception->getMessage(),
                    'file' => $exception->getFile(),
                    'line' => $exception->getLine(),
                    'code' => $exception->getCode(),
                ];
            }
        }

        $response = response()
            ->json($body, $status)
            ->header('Content-Type', 'application/problem+json')
            ->header('X-Request-Id', $requestId);

        return !empty($headers) ? $response->withHeaders($headers) : $response;
    }

    /**
     * @param array<string, mixed> $extra
     */
    public function internalError(string|null $detail = null, Throwable|null $exception = null, array $extra = []): JsonResponse
    {
        return $this->problem(
            status: Response::HTTP_INTERNAL_SERVER_ERROR,
            title: __('Server Error'),
            detail: $detail,
            appCode: Response::HTTP_INTERNAL_SERVER_ERROR,
            type: $this->problemType('internal-error'),
            extra: $extra,
            exception: $exception,
        );
    }

    public function badRequest(string|null $detail = null): JsonResponse
    {
        return $this->problem(
            status: Response::HTTP_BAD_REQUEST,
            title: __('Bad Request'),
            detail: $detail,
            appCode: Response::HTTP_BAD_REQUEST,
            type: $this->problemType('bad-request'),
        );
    }

    public function unauthorized(string|null $detail = null): JsonResponse
    {
        return $this->problem(
            status: Response::HTTP_UNAUTHORIZED,
            title: __('Unauthenticated'),
            detail: $detail,
            appCode: Response::HTTP_UNAUTHORIZED,
            type: $this->problemType('unauthenticated'),
        );
    }

    public function forbidden(string|null $detail = null): JsonResponse
    {
        return $this->problem(
            status: Response::HTTP_FORBIDDEN,
            title: __('Forbidden'),
            detail: $detail,
            appCode: Response::HTTP_FORBIDDEN,
            type: $this->problemType('forbidden'),
        );
    }

    /**
     * @param array<string, string> $headers
     */
    public function errorWithData(string $title, int $status = Response::HTTP_BAD_REQUEST, string|null $detail = null, mixed $data = null, array $headers = [], int|null $appCode = null): JsonResponse
    {
        $extra = [];

        if (!is_null($data)) {
            $extra['data'] = $data; // RFC7807 extensions allowed
        }

        return $this->problem(
            status: $status,
            title: $title,
            detail: $detail,
            appCode: $appCode,
            type: $this->problemType('error'),
            extra: $extra,
            headers: $headers,
        );
    }

    /**
     * @param array<string, mixed> $extra
     * @param array<string, string> $headers
     */
    public function errorWithExtra(string $title, int $status = Response::HTTP_BAD_REQUEST, string|null $detail = null, array $extra = [], array $headers = [], int|null $appCode = null): JsonResponse
    {
        return $this->problem(
            status: $status,
            title: $title,
            detail: $detail,
            appCode: $appCode,
            type: $this->problemType('error'),
            extra: $extra,
            headers: $headers,
        );
    }

    /**
     * @param array<string, string[]> $errors
     */
    public function validation(string $title = 'Validation Error', array $errors = [], int $status = Response::HTTP_UNPROCESSABLE_ENTITY): JsonResponse
    {
        $firstMessage = null;
        if ($first = array_key_first($errors)) {
            $firstMessage = $errors[$first][0];
        }

        return $this->problem(
            status: $status,
            title: __($title),
            detail: $firstMessage ?? __('One or more fields are invalid.'),
            type: $this->problemType('validation-error'),
            extra: $errors !== [] ? ['errors' => $errors] : []
        );
    }

    // --- Pagination normalization helpers ---

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>|null
     */
    private function paginationFromResourceCollectionPayload(array $payload): array|null
    {
        if (!isset($payload['meta'], $payload['links']) || !is_array($payload['meta']) || !is_array($payload['links'])) {
            return null;
        }

        $meta = $payload['meta'];
        $links = $payload['links'];

        return array_filter([
            'total' => $meta['total'] ?? null,
            'perPage' => $meta['per_page'] ?? null,
            'currentPage' => $meta['current_page'] ?? null,
            'lastPage' => $meta['last_page'] ?? null,
            'from' => $meta['from'] ?? null,
            'to' => $meta['to'] ?? null,
            'path' => $meta['path'] ?? null,

            'firstPageUrl' => $links['first'] ?? null,
            'lastPageUrl' => $links['last'] ?? null,
            'nextPageUrl' => $links['next'] ?? null,
            'prevPageUrl' => $links['prev'] ?? null,
        ], static fn ($v) => !is_null($v) && $v !== '');
    }

    /**
     * @template T
     * @param LengthAwarePaginator<int, T> $p
     * @return array<string, mixed>
     */
    private function paginationFromLengthAwarePaginator(LengthAwarePaginator $p): array
    {
        $data = $p->toArray();

        return array_filter([
            'total' => $data['total'] ?? null,
            'perPage' => $data['per_page'] ?? null,
            'currentPage' => $data['current_page'] ?? null,
            'lastPage' => $data['last_page'] ?? null,
            'from' => $data['from'] ?? null,
            'to' => $data['to'] ?? null,
            'path' => $data['path'] ?? null,

            'firstPageUrl' => $data['first_page_url'] ?? null,
            'lastPageUrl' => $data['last_page_url'] ?? null,
            'nextPageUrl' => $data['next_page_url'] ?? null,
            'prevPageUrl' => $data['prev_page_url'] ?? null,
        ], static fn ($v) => !is_null($v) && $v !== '');
    }

    /**
     * @template T
     * @param Paginator<int, T> $p
     * @return array<string, mixed>
     */
    private function paginationFromPaginator(Paginator $p): array
    {
        $data = $p->toArray();

        return array_filter([
            'perPage' => $data['per_page'] ?? null,
            'currentPage' => $data['current_page'] ?? null,
            'from' => $data['from'] ?? null,
            'to' => $data['to'] ?? null,
            'path' => $data['path'] ?? null,

            'firstPageUrl' => $data['first_page_url'] ?? null,
            'nextPageUrl' => $data['next_page_url'] ?? null,
            'prevPageUrl' => $data['prev_page_url'] ?? null,
        ], static fn ($v) => !is_null($v) && $v !== '');
    }
}
