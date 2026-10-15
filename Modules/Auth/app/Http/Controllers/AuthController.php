<?php

declare(strict_types=1);

namespace Modules\Auth\Http\Controllers;

use App\Http\Controllers\Controller;
use App\Http\Requests\Auth\RegisterRequest;
use App\UseCase\UserUseCase;
use DTO\CreateUserData;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class AuthController extends Controller
{
    public function __construct(
        private readonly UserUseCase $userUseCase,
    ){
    }

    /**
     * Store a newly created resource in storage.
     */
    public function store(RegisterRequest $request)
    {
        try {
            $this->userUseCase->createUser(
                new CreateUserData(
                    username: $request->string('username')->value(),
                    password: $request->string('password')->value(),
                    email: $request->string('email')->value(),
                )
            );
        }catch(\Throwable $e){
            scope_logger_error(
                'Error during creating new user',
                __METHOD__,
                'message',
                $e->getMessage(),
                'error',
                $e
            );
            return responder()->problem(
                status: Response::HTTP_INTERNAL_SERVER_ERROR,
                title: __('Server Error'),
                detail: 'ویرایش بنر با خطا مواجه شد.',
            );
        }
        return responder()->success('احراز هویت با موفقیت انجام شد!');
    }

    /**
     * Show the specified resource.
     */
    public function show($id)
    {
        return view('auth::show');
    }

    /**
     * Show the form for editing the specified resource.
     */
    public function edit($id)
    {
        return view('auth::edit');
    }

    /**
     * Update the specified resource in storage.
     */
    public function update(Request $request, $id)
    {
    }

    /**
     * Remove the specified resource from storage.
     */
    public function destroy($id)
    {
    }
}
