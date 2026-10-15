<?php

namespace DTO;

class CreateUserData
{
    public function __construct(
        public string $username,
        public string $password,
        public string $email,
    ){
    }
}
