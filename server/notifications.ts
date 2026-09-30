export interface NotificationProjection {
  title: string;
  body: string;
  payload: Record<string, string | number>;
}

const notificationText: Record<string, Pick<NotificationProjection, 'title' | 'body'>> = {
  'conversation.message.created': { title: 'Нове повідомлення', body: 'У вашій поїздці є нове повідомлення.' },
  'booking.confirmed': { title: 'Бронювання підтверджено', body: 'Статус поїздки оновлено.' },
  'booking.cancelled': { title: 'Бронювання скасовано', body: 'Місця звільнено. Перевірте актуальний стан поїздки.' },
  'booking.changed': { title: 'Оновлення поїздки', body: 'Статус бронювання змінився.' },
  'proposal.created': { title: 'Нова пропозиція водія', body: 'Перегляньте умови у своїх заявках.' },
  'proposal.countered': { title: 'Зустрічна пропозиція', body: 'Учасник змінив ціну або час поїздки.' },
  'proposal.updated': { title: 'Оновлення домовленості', body: 'Перегляньте актуальні умови пропозиції.' },
  'proposal.accepted': { title: 'Домовленість підтверджена', body: 'Бронювання створено на сервері.' },
  'proposal.closed': { title: 'Пропозицію закрито', body: 'Перевірте статус заявки на поїздку.' },
  'navigation.match.driver-interested': { title: 'Водій зацікавився маршрутом', body: 'Перегляньте пропозицію у своїх заявках.' },
  'navigation.match.passenger-confirmed': { title: 'Пасажир підтвердив інтерес', body: 'Продовжіть узгодження після безпечної зупинки.' },
  'navigation.route-updated': { title: 'Маршрут водія оновлено', body: 'Підтверджену поїздку додано до маршруту.' },
  'journey.updated': { title: 'План маршруту оновлено', body: 'Відкрийте поїздки, щоб переглянути актуальний стан.' },
  'journey.started': { title: 'Подорож розпочато', body: 'Стежте за актуальним станом наступного відрізка.' },
  'journey.leg.started': { title: 'Відрізок маршруту розпочато', body: 'MARSHGO оновив стан вашої подорожі.' },
  'journey.leg.completed': { title: 'Відрізок маршруту завершено', body: 'Перевірте час і стан наступної пересадки.' },
  'journey.completed': { title: 'Подорож завершено', body: 'Усі відрізки маршруту завершені.' },
  'rendezvous.activated': { title: 'Зустріч активна', body: 'Обмін поточним місцем доступний лише учасникам бронювання.' },
  'rendezvous.driver.arrived': { title: 'Водій на місці', body: 'Водій підтвердив прибуття до точки посадки.' },
  'rendezvous.passenger.arrived': { title: 'Пасажир на місці', body: 'Пасажир підтвердив прибуття до точки посадки.' },
  'rendezvous.driver.delayed': { title: 'Затримка водія', body: 'Водій повідомив про затримку зустрічі.' },
  'rendezvous.passenger.delayed': { title: 'Затримка пасажира', body: 'Пасажир повідомив про затримку зустрічі.' },
  'rendezvous.driver.will-arrive': { title: 'Водій оновив час прибуття', body: 'Перевірте статус зустрічі перед посадкою.' },
  'rendezvous.passenger.will-arrive': { title: 'Пасажир оновив час прибуття', body: 'Перевірте статус зустрічі перед посадкою.' },
  'rendezvous.both-nearby': { title: 'Ви поруч із точкою посадки', body: 'Обидва учасники підтвердили, що прибули.' },
  'rendezvous.boarding': { title: 'Починається посадка', body: 'Підтвердіть поїздку через бронювання та квиток.' },
  'rendezvous.cancelled': { title: 'Зустріч завершена', body: 'Обмін геолокацією для цієї зустрічі вимкнено.' },
};

const identifierKeys = new Set([
  'booking_id', 'offer_id', 'journey_id', 'journey_leg_id', 'proposal_id', 'demand_id',
  'candidate_id', 'navigation_session_id', 'conversation_id', 'rendezvous_id',
]);
const statusKeys = new Set(['status', 'state']);

export function projectNotification(eventType: string, value: unknown): NotificationProjection | null {
  const text = notificationText[eventType];
  if (!text) return null;
  const source = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const payload: NotificationProjection['payload'] = { eventType };
  for (const [key, item] of Object.entries(source)) {
    if (!identifierKeys.has(key) && !statusKeys.has(key) && key !== 'revision_number') continue;
    if (typeof item === 'string' && /^[0-9a-f-]{36}$/i.test(item)) payload[key] = item;
    else if (statusKeys.has(key) && typeof item === 'string' && /^[a-z_]{1,40}$/i.test(item)) payload[key] = item;
    else if (key === 'revision_number' && typeof item === 'number' && Number.isInteger(item) && item >= 1) payload[key] = item;
  }
  return { ...text, payload };
}
