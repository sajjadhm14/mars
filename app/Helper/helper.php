<?php


use App\Common\Api\ApiResponder;

if (! function_exists('scope_logger_error')) {
    /**
     * @param mixed ...$context
     */
    function scope_logger_error(
        string $message,
        string $scope,
               ...$context
    ): void {
        scope_logger($message, $scope, 'error', ...$context);
    }
}

if (! function_exists('scope_logger')) {
    /**
     * @param mixed ...$context
     */
    function scope_logger(
        string $message,
        string $scope,
        string $type,
               ...$context
    ): void {
        $root_context = [
            'scope' => $scope,
        ];

        if ($len = count($context)) {
            if ($len % 2 !== 0) {
                $len--;
            }
            for ($i = 0; $i < $len; $i = $i + 2) {
                $root_context[$context[$i]] = $context[$i + 1];
            }
        }

        logger()->{$type}($message, $root_context);
    }
}

if (! function_exists('responder')) {
    function responder(): ApiResponder
    {
        return app()->make(ApiResponder::class);
    }
}

if (! function_exists('api_request_id')) {
    function api_request_id(): string
    {
        $ctx = Context::get('request_id');

        if (is_string($ctx) && $ctx !== '') {
            return $ctx;
        }

        $headerId = request()->headers->get('X-Request-Id')
            ?? request()->headers->get('X-Correlation-Id');

        return is_string($headerId) && $headerId !== ''
            ? $headerId
            : (string)Str::uuid();
    }
}
