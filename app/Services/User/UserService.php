<?php

namespace App\Services\User;

use App\DTO\UserResponseData;
use App\Services\Contracts\UserServiceInterface;
use DTO\CreateUserData;
use Modules\User\Models\User;

class UserService implements UserServiceInterface
{
    public function createUser(CreateUserData $data): UserResponseData
    {
        return User::createUser($data)->toResponse();
    }
}
