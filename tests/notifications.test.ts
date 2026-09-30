import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { projectNotification } from '../server/notifications';

describe('persistent notification projection', () => {
  it('keeps message content and personal fields out of the inbox payload', () => {
    const projected = projectNotification('conversation.message.created', {
      conversation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sender_name: 'Private name', body: 'A private chat message', sender_phone: '+380000000000',
    });
    assert.deepEqual(projected, {
      title: 'Нове повідомлення',
      body: 'У вашій поїздці є нове повідомлення.',
      payload: { eventType: 'conversation.message.created', conversation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    });
  });

  it('only projects allowlisted events and safe identifiers', () => {
    assert.equal(projectNotification('unrecognized.event', { id: 'x' }), null);
    const projected = projectNotification('journey.updated', {
      journey_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', state: 'REPLANNING', origin_name: 'Private address',
    });
    assert.deepEqual(projected?.payload, {
      eventType: 'journey.updated', journey_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', state: 'REPLANNING',
    });
  });
});
