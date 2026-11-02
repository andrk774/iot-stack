// Настройки → Общий доступ: участники моего дома, приглашения, чужие дома, куда пригласили меня.
import { h, mount, toast, modal, field, copyText, actionButton } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { store } from '../store.js';
import { errorMessage } from '../format.js';
import { ROLE_LABELS, ROLE_HINTS } from '../access.js';

const roleSelect = (value) => {
  const sel = h('select', null, ...['view', 'control', 'admin'].map((r) => h('option', { value: r }, ROLE_LABELS[r])));
  sel.value = value;
  return sel;
};

function inviteDialog(onDone) {
  const role = roleSelect('control');
  const hint = h('p', { class: 'field-hint' }, ROLE_HINTS.control);
  role.addEventListener('change', () => { hint.textContent = ROLE_HINTS[role.value]; });
  const ok = h('button', { class: 'btn btn-primary', type: 'button' }, 'Создать ссылку');
  const error = h('p', { class: 'form-error', role: 'alert' });
  const dlg = modal('Пригласить в дом', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Приглашённый увидит все ваши устройства, сценарии и уведомления — в пределах выбранной роли. Ссылка одноразовая и действует 7 дней. Регистрация по ней работает, даже если она закрыта на сервере.'),
    field('Роль', role), hint, error), [ok]);
  ok.addEventListener('click', async () => {
    try {
      const inv = await post('/api/invites', { role: role.value });
      dlg.close();
      onDone();
      modal('Ссылка-приглашение', h('div', { class: 'stack' },
        h('p', null, 'Отправьте её тому, кого приглашаете. Показывается один раз.'),
        h('div', { class: 'secret' }, h('code', null, inv.url),
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => copyText(inv.url) }, 'Копировать'))));
    } catch (e) { error.textContent = errorMessage(e); }
  });
}

export function membersSection() {
  const mine = h('div', { class: 'stack' });
  const theirs = h('div', { class: 'stack' });

  const load = async () => {
    try {
      const [{ members, invites }] = await Promise.all([get('/api/members'), store.loadHomes()]);
      mount(mine,
        h('div', { class: 'panel-head', style: { marginBottom: 0 } }, h('h3', { class: 'subhead' }, 'Мой дом'),
          h('button', { class: 'btn btn-primary btn-small', type: 'button', onclick: () => inviteDialog(load) }, 'Пригласить')),
        members.length === 0 && invites.length === 0
          ? h('p', { class: 'muted' }, 'Пока доступ только у вас. Пригласите членов семьи: каждому — своя роль, свои каналы уведомлений.')
          : h('div', { class: 'list' },
            ...members.map((m) => {
              const sel = roleSelect(m.role);
              sel.setAttribute('aria-label', `Роль ${m.email}`);
              sel.addEventListener('change', async () => {
                try { await put(`/api/members/${m.user_id}`, { role: sel.value }); toast('Роль изменена'); } catch (e) { toast(errorMessage(e), 'error'); sel.value = m.role; }
              });
              return h('div', { class: 'list-row' },
                h('span', { class: 'state state-ok' }, h('span', { class: 'state-dot', 'aria-hidden': 'true' })),
                h('div', null, h('span', { class: 'title' }, m.email), h('div', { class: 'list-sub' }, `с ${new Date(m.created_at).toLocaleDateString('ru-RU')}`)),
                h('div', { class: 'row-actions', style: { marginTop: 0 } }, sel,
                  actionButton('Убрать', async () => {
                    if (!confirm(`Закрыть доступ для ${m.email}?`)) return;
                    try { await del(`/api/members/${m.user_id}`); await load(); } catch (e) { toast(errorMessage(e), 'error'); }
                  }, 'btn btn-small btn-danger')));
            }),
            ...invites.map((i) => h('div', { class: 'list-row' },
              h('span', { class: 'state state-warn' }, h('span', { class: 'state-dot', 'aria-hidden': 'true' })),
              h('div', null, h('span', { class: 'title' }, 'Приглашение не принято'),
                h('div', { class: 'list-sub' }, `${ROLE_LABELS[i.role]} · действует до ${new Date(i.expires_at).toLocaleDateString('ru-RU')}`)),
              actionButton('Отозвать', async () => {
                try { await del(`/api/invites/${i.id}`); await load(); } catch (e) { toast(errorMessage(e), 'error'); }
              }, 'btn btn-small')))));

      const others = store.homes.filter((x) => x.role !== 'owner');
      mount(theirs, h('h3', { class: 'subhead' }, 'Дома, куда пригласили меня'),
        others.length === 0 ? h('p', { class: 'muted' }, 'Нет. Чтобы получить доступ, откройте ссылку-приглашение от владельца.')
          : h('div', { class: 'list' }, ...others.map((x) => h('div', { class: 'list-row' },
            h('span', { class: 'state state-ok' }, h('span', { class: 'state-dot', 'aria-hidden': 'true' })),
            h('div', null, h('span', { class: 'title' }, x.owner_email), h('div', { class: 'list-sub' }, ROLE_LABELS[x.role])),
            actionButton('Выйти', async () => {
              if (!confirm(`Отказаться от доступа к дому ${x.owner_email}?`)) return;
              try {
                await del(`/api/members/${store.me.id}?owner=${x.owner_id}`);
                await store.loadDevices();
                await load();
              } catch (e) { toast(errorMessage(e), 'error'); }
            }, 'btn btn-small')))));
    } catch (e) {
      mount(mine, h('p', { class: 'form-error' }, errorMessage(e)));
    }
  };
  load();
  return h('section', { class: 'panel stack-lg', 'aria-labelledby': 'share-title' },
    h('h2', { id: 'share-title', class: 'section-title' }, 'Общий доступ'), mine, theirs);
}

/** #/join/<код>: принять приглашение (после входа или регистрации) */
export async function acceptPendingInvite(code) {
  const res = await post('/api/invites/accept', { code });
  await store.loadHomes();
  await store.loadDevices();
  toast(`Готово: доступ к дому ${res.owner_email} (${ROLE_LABELS[res.role]})`);
}
