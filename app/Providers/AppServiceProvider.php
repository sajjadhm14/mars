<?php

declare(strict_types=1);

namespace App\Providers;

use App\Services\Contracts\UserServiceInterface;
use App\Services\User\UserService;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        $this->registerServices();
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        //
    }

    private function registerServices(): void
    {
        $this->app->singleton(UserServiceInterface::class, UserService::class);
    }
}
