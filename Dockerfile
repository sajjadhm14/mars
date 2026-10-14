FROM php:8.4-fpm-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq-dev libzip-dev unzip \
    && docker-php-ext-install pdo_pgsql zip pcntl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
WORKDIR /var/www/html
COPY docker/entrypoint.sh /usr/local/bin/mars-entrypoint
RUN chmod +x /usr/local/bin/mars-entrypoint

EXPOSE 3000
ENTRYPOINT ["mars-entrypoint"]
CMD ["php", "artisan", "serve", "--host=0.0.0.0", "--port=3000"]
