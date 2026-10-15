<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Route;
use Modules\Auth\Http\Controllers\AuthController;

Route::post('/', [AuthController::class, 'store'])->name('register');

Route::middleware(['auth:sanctum'])->prefix('v1')->group(function () {
    Route::apiResource('auth', AuthController::class)->names('auth');
});
