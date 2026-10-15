<?php

namespace App\UseCase;

use App\DTO\UserResponseData;
use App\Services\Contracts\UserServiceInterface;
use DTO\CreateUserData;

readonly class UserUseCase
{
    public function __construct(
        private UserServiceInterface $userService,
    ){
    }

    public function createUser(CreateUserData $data): UserResponseData
    {
        return $this->userService->createuser($data);
    }
}
