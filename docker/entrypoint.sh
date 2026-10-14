#!/bin/sh
set -eu

# Dependencies live in the bind mount so editors can inspect vendor classes.
composer install --no-interaction --prefer-dist
if [ ! -f .env ]; then
    cp .env.example .env
fi
if ! grep -Eq '^APP_KEY=.+$' .env; then
    php artisan key:generate --ansi
fi

# Schema changes are deliberately run by the developer, never on startup.
exec "$@"
