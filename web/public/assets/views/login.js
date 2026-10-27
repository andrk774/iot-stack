import { h, mount, field } from '../dom.js';
import { post, setToken } from '../api.js';
import { errorMessage } from '../format.js';

export function renderLogin(root) {
  let mode = 'login';
  const email = h('input', { type: 'email', name: 'email', required: true, autocomplete: 'username', maxlength: 254 });
  const password = h('input', { type: 'password', name: 'password', required: true, minlength: 8, maxlength: 128, autocomplete: 'current-password' });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn btn-primary btn-wide', type: 'submit' });
  const switcher = h('button', { class: 'link', type: 'button' });
  const title = h('h1');

  const draw = () => {
    title.textContent = mode === 'login' ? 'Вход' : 'Регистрация';
    submit.textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
    switcher.textContent = mode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти';
    password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    error.textContent = '';
  };
  switcher.addEventListener('click', () => { mode = mode === 'login' ? 'register' : 'login'; draw(); });

  const form = h('form', { class: 'auth-card' },
    h('div', { class: 'brand brand-large' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), 'Домашний IoT'),
    title,
    field('Email', email),
    field('Пароль', password, 'Не короче 8 символов'),
    error, submit, switcher);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    error.textContent = '';
    try {
      const res = await post(mode === 'login' ? '/api/auth/login' : '/api/auth/register',
        { email: email.value.trim(), password: password.value });
      setToken(res.token);
    } catch (err) {
      error.textContent = errorMessage(err);
    } finally {
      submit.disabled = false;
    }
  });

  draw();
  mount(root, h('main', { class: 'auth' }, form));
  setTimeout(() => email.focus(), 0);
  return () => {};
}
