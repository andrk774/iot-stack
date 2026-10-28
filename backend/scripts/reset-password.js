// Сброс пароля пользователя администратором сервера (письма платформа не отправляет).
//   docker compose exec backend node scripts/reset-password.js user@example.com
// Печатает новый временный пароль, завершает все сеансы и отключает 2FA, если указан --no-2fa.
import pg from 'pg';
import crypto from 'node:crypto';
import { hashSecret } from '../src/security.js';

const [email, flag] = process.argv.slice(2);
if (!email) {
  console.error('Использование: node scripts/reset-password.js <email> [--no-2fa]');
  process.exit(2);
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const password = crypto.randomBytes(12).toString('base64url');
const { rows } = await db.query(
  `UPDATE users SET password_hash = $2, password_changed_at = now()
     ${flag === '--no-2fa' ? ", totp_secret = NULL, totp_pending = NULL, recovery_codes = '{}'" : ''}
   WHERE email = lower($1) RETURNING id`, [email, await hashSecret(password)]);
if (!rows[0]) {
  console.error(`Пользователь ${email} не найден`);
  process.exit(1);
}
await db.query('DELETE FROM sessions WHERE user_id = $1', [rows[0].id]);
console.log(`Новый пароль для ${email}: ${password}`);
console.log('Все сеансы завершены. Смените пароль в панели: Настройки → Безопасность.');
await db.end();
