<?php

namespace App\Services\Contracts;

use App\DTO\UserResponseData;
use DTO\CreateUserData;

interface UserServiceInterface
{
    public function createUser(CreateUserData $data): UserResponseData;
}
