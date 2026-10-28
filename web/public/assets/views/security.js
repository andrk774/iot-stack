// Настройки → Безопасность: пароль, двухфакторная защита, активные сеансы.
import { h, mount, toast, modal, field, copyText, actionButton } from '../dom.js';
import { get, post, del } from '../api.js';
import { relativeTime, errorMessage } from '../format.js';
import { qrSvg } from '../qr.js';

/** «Chrome, Windows» из User-Agent — грубо, только чтобы узнать свой сеанс */
export function describeAgent(ua) {
  if (!ua) return 'Неизвестное устройство';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /YaBrowser/.test(ua) ? 'Яндекс Браузер'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari'
      : /curl|python|node|okhttp/i.test(ua) ? 'Программа' : 'Браузер';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser}, ${os}` : browser;
}

function passwordPanel() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password', maxlength: 128 });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 128 });
  const again = h('input', { type: 'password', autocomplete: 'new-password', maxlength: 128 });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const save = actionButton('Сменить пароль', async () => {
    error.textContent = '';
    if (next.value.length < 8) { error.textContent = 'Новый пароль — не короче 8 символов'; return; }
    if (next.value !== again.value) { error.textContent = 'Пароли не совпадают'; return; }
    try {
      const r = await post('/api/auth/password', { current_password: cur.value, new_password: next.value });
      cur.value = ''; next.value = ''; again.value = '';
      toast(r.sessions_closed ? `Пароль изменён, завершено других сеансов: ${r.sessions_closed}` : 'Пароль изменён');
      sessionsPanel.reload?.();
    } catch (e) { error.textContent = errorMessage(e); }
  }, 'btn btn-primary');
  return h('div', { class: 'stack' },
    h('h3', { class: 'subhead' }, 'Пароль'),
    h('div', { class: 'grid-3 grid-even' }, field('Текущий пароль', cur), field('Новый пароль', next, 'Не короче 8 символов'), field('Ещё раз', again)),
    h('p', { class: 'field-hint' }, 'После смены пароля все остальные сеансы завершаются. Забыли пароль — администратор сервера сбросит его командой scripts/reset-password.js.'),
    error,
    h('div', { class: 'row-actions', style: { marginTop: 0 } }, save));
}

function showRecoveryCodes(codes) {
  const text = codes.join('\n');
  modal('Коды восстановления', h('div', { class: 'stack' },
    h('p', null, 'Сохраните их в надёжном месте: каждый код заменяет код из приложения один раз, если телефон потерян. Больше они не покажутся.'),
    h('pre', { class: 'snippet codes' }, text),
    h('button', { class: 'btn btn-small', type: 'button', onclick: () => copyText(text) }, 'Копировать')));
}

function totpPanel(me, refresh) {
  const box = h('div', { class: 'stack' }, h('h3', { class: 'subhead' }, 'Двухфакторная защита'));
  if (!me.totp_enabled) {
    box.append(
      h('p', { class: 'muted' }, 'Кроме пароля при входе понадобится код из приложения-аутентификатора (Google Authenticator, Яндекс Ключ, Aegis, 1Password и др.).'),
      h('div', { class: 'row-actions', style: { marginTop: 0 } }, actionButton('Включить', async () => {
        let setup;
        try { setup = await post('/api/auth/totp/setup'); } catch (e) { toast(errorMessage(e), 'error'); return; }
        const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '123456' });
        const error = h('p', { class: 'form-error', role: 'alert' });
        const ok = h('button', { class: 'btn btn-primary', type: 'button' }, 'Подтвердить');
        const dlg = modal('Подключение приложения', h('div', { class: 'stack' },
          h('p', null, 'Отсканируйте код в приложении-аутентификаторе или введите ключ вручную.'),
          h('div', { class: 'qr' }, qrSvg(setup.otpauth_url, { px: 220 })),
          h('div', { class: 'secret' }, h('code', null, setup.secret.replace(/(.{4})/g, '$1 ').trim()),
            h('button', { class: 'btn btn-small', type: 'button', onclick: () => copyText(setup.secret) }, 'Копировать')),
          h('p', null, h('a', { href: setup.otpauth_url }, 'Открыть в приложении на этом устройстве')),
          field('Код из приложения', code), error), [ok]);
        setTimeout(() => code.focus(), 50);
        const confirm = async () => {
          error.textContent = '';
          try {
            const r = await post('/api/auth/totp/enable', { code: code.value.trim() });
            dlg.close();
            showRecoveryCodes(r.recovery_codes);
            refresh();
          } catch (e) { error.textContent = errorMessage(e); }
        };
        ok.addEventListener('click', confirm);
        code.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } });
      }, 'btn btn-primary')));
    return box;
  }
  const askPassword = (title, withCode, run) => {
    const pw = h('input', { type: 'password', autocomplete: 'current-password' });
    const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 20 });
    const error = h('p', { class: 'form-error', role: 'alert' });
    const ok = h('button', { class: 'btn btn-primary', type: 'button' }, 'Продолжить');
    const dlg = modal(title, h('div', { class: 'stack' }, field('Пароль', pw),
      withCode ? field('Код из приложения', code, 'или код восстановления') : null, error), [ok]);
    ok.addEventListener('click', async () => {
      error.textContent = '';
      try { await run(pw.value, code.value.trim()); dlg.close(); } catch (e) { error.textContent = errorMessage(e); }
    });
  };
  box.append(
    h('p', null, h('span', { class: 'state state-ok' }, h('span', { class: 'state-dot', 'aria-hidden': 'true' }), 'включена'),
      ` · кодов восстановления осталось: ${me.recovery_codes_left}`),
    h('div', { class: 'row-actions', style: { marginTop: 0 } },
      h('button', { class: 'btn', type: 'button', onclick: () => askPassword('Новые коды восстановления', false, async (password) => {
        const r = await post('/api/auth/totp/recovery-codes', { password });
        showRecoveryCodes(r.recovery_codes);
        refresh();
      }) }, 'Новые коды восстановления'),
      h('button', { class: 'btn btn-danger', type: 'button', onclick: () => askPassword('Выключить двухфакторную защиту', true, async (password, code) => {
        await post('/api/auth/totp/disable', { password, code });
        toast('Двухфакторная защита выключена');
        refresh();
      }) }, 'Выключить')));
  return box;
}

function sessionsPanel() {
  const list = h('div', { class: 'list' });
  const box = h('div', { class: 'stack' },
    h('div', { class: 'panel-head', style: { marginBottom: 0 } }, h('h3', { class: 'subhead' }, 'Активные сеансы'),
      actionButton('Завершить все, кроме этого', async () => {
        try { const r = await post('/api/sessions/revoke-others'); toast(`Завершено: ${r.closed}`); await load(); } catch (e) { toast(errorMessage(e), 'error'); }
      }, 'btn btn-small')),
    list);
  const load = async () => {
    try {
      const { sessions } = await get('/api/sessions');
      mount(list, ...sessions.map((s) => h('div', { class: 'list-row' },
        h('span', { class: `state ${s.current ? 'state-ok' : ''}` }, h('span', { class: 'state-dot', 'aria-hidden': 'true' }), s.current ? 'этот' : ''),
        h('div', null,
          h('span', { class: 'title' }, describeAgent(s.user_agent)),
          h('div', { class: 'list-sub' }, [s.ip, `вход ${new Date(s.created_at).toLocaleDateString('ru-RU')}`, `активен ${relativeTime(s.last_seen_at)}`].filter(Boolean).join(' · '))),
        s.current ? h('span') : actionButton('Завершить', async () => {
          try { await del(`/api/sessions/${s.id}`); await load(); } catch (e) { toast(errorMessage(e), 'error'); }
        }, 'btn btn-small'))));
    } catch (e) {
      mount(list, h('p', { class: 'form-error' }, errorMessage(e)));
    }
  };
  sessionsPanel.reload = load;
  load();
  return box;
}

export function securitySection() {
  const totpHost = h('div');
  const refresh = async () => {
    try { mount(totpHost, totpPanel(await get('/api/me'), refresh)); } catch (e) { mount(totpHost, h('p', { class: 'form-error' }, errorMessage(e))); }
  };
  refresh();
  return h('section', { class: 'panel stack-lg', 'aria-labelledby': 'sec-title' },
    h('h2', { id: 'sec-title', class: 'section-title' }, 'Безопасность'),
    passwordPanel(), totpHost, sessionsPanel());
}
