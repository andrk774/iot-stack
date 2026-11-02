// Общий доступ в панели: роли и выбор дома.
import { h } from './dom.js';
import { store } from './store.js';

export const ROLE_RANK = { view: 1, control: 2, admin: 3, owner: 4 };
export const ROLE_LABELS = { owner: 'владелец', admin: 'администратор', control: 'управление', view: 'просмотр' };
export const ROLE_HINTS = {
  view: 'видит устройства, графики, сценарии и уведомления',
  control: 'ещё управляет устройствами и запускает сценарии',
  admin: 'ещё добавляет и меняет устройства, сценарии, мосты, обновляет прошивки',
};

/** Хватает ли роли (объект с my_role; нет поля — свой) */
export const can = (obj, min) => ROLE_RANK[obj?.my_role || 'owner'] >= ROLE_RANK[min];

/** Название дома для заголовков: «Мой дом» или e-mail владельца */
export function homeLabel(ownerId) {
  if (!ownerId || ownerId === store.me?.id) return 'Мой дом';
  const home = store.homes.find((x) => x.owner_id === ownerId);
  return home ? `Дом ${home.owner_email}` : 'Чужой дом';
}

export const sharedMode = () => store.homes.length > 1;

/** Выбор дома для нового объекта (только дома, где хватает роли). null — выбирать не из чего */
export function homeSelect(min = 'admin') {
  const homes = store.homes.filter((x) => ROLE_RANK[x.role] >= ROLE_RANK[min]);
  if (homes.length < 2) return null;
  const sel = h('select', { 'aria-label': 'Дом' },
    ...homes.map((x) => h('option', { value: x.owner_id }, x.role === 'owner' ? 'Мой дом' : `Дом ${x.owner_email}`)));
  return sel;
}
