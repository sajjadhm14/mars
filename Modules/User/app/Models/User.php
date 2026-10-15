<?php

namespace Modules\User\Models;

use App\DTO\UserResponseData;
use Database\Factories\UserFactory;
use DTO\CreateUserData;
use Illuminate\Database\Eloquent\Attributes\UseFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;

#[UseFactory(UserFactory::class)]
class User extends Authenticatable
{
    /** @use HasFactory<UserFactory> */
    use HasFactory, Notifiable;

    /**
     * The attributes that are mass assignable.
     */
    protected $fillable = ['name', 'email', 'password'];

    protected $hidden = ['password', 'remember_token'];

    /**
     * Get the attributes that should be cast.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
        ];
    }

    public static function createUser(CreateUserData $data): self
    {
        $new = new self();
        $new->username = $data->username;
        $new->password = $data->password;
        $new->email = $data->email;
        $new->save();
        return $new;
    }

    public function toResponse(): UserResponseData
    {
        return new UserResponseData(
            id: $this->id,
            username: $this->username,
            email: $this->email,
            password: $this->password,
            created_at: $this->created_at,
            updated_at: $this->updated_at,
        );
    }
}
