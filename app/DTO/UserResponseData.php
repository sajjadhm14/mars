<?php

namespace App\DTO;

use Carbon\Carbon;
use Illuminate\Contracts\Support\Arrayable;

class UserResponseData implements Arrayable
{
    public function __construct(
        public string $id,
        public string $username,
        public string $email,
        public string $password,
        public Carbon|null $created_at = null,
        public Carbon|null $updated_at = null,
    ){
    }
    /**
     * @inheritDoc
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'username' => $this->username,
            'email' => $this->email,
            'password' => $this->password,
            'created_at' => $this->created_at,
            'updated_at' => $this->updated_at,
        ];
    }
}
