# Mars — Laravel 13

بک‌اند اصلی پروژه اکنون Laravel 13 است و مستقیماً در همین پوشه قرار دارد.
Composer و وابستگی‌ها نصب شده‌اند و APP_KEY تنظیم شده است.
لاگین و APIهای اختصاصی هنوز پیاده‌سازی نشده‌اند؛ routes/api.php آمادهٔ کدنویسی است.

## اجرا

```bash
docker compose up -d --build
docker compose exec mars php artisan test
docker compose exec mars php artisan migrate
```

- Laravel: http://localhost:8001
- React: http://localhost:3000
- Mailpit: http://localhost:8025

این محیط توسعه از artisan serve و bind mount استفاده می‌کند.
سرویس Node و worker قدیمی با Laravel جایگزین شده‌اند.
دیتابیس Laravel volume جدا دارد؛ volume داده‌های Node حذف نشده است.
migrationهای پیش‌فرض اجرا شده‌اند؛ هنگام روشن‌شدن مجدد خودکار اجرا نمی‌شوند.
کد قدیمی در پوشهٔ همسایهٔ زیر نگه داشته شده است:

/home/sajjadhm14/projects/mars-node-backup-20261014-191447
