<?php

namespace App\Common\Api;

use Illuminate\Http\JsonResponse;

class NoContentResponse extends JsonResponse
{
    /**
     * @param array<string, string> $headers
     */
    public function __construct(array $headers = [])
    {
        parent::__construct(null, self::HTTP_NO_CONTENT, $headers);
    }
}
