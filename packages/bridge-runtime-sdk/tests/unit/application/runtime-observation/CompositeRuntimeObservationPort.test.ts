import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompositeRuntimeObservationPort,
  type RuntimeObservationEvent,
  type RuntimeObservationPort,
} from '@/application/runtime-observation/index.ts';

class RecordingPort implements RuntimeObservationPort {
  readonly events: RuntimeObservationEvent[] = [];

  record(event: RuntimeObservationEvent): void {
    this.events.push(event);
  }
}

test('CompositeRuntimeObservationPort fans out each event to every port in order', () => {
  const first = new RecordingPort();
  const second = new RecordingPort();
  const composite = new CompositeRuntimeObservationPort([first, second]);
  const event: RuntimeObservationEvent = {
    type: 'runtime_lifecycle',
    action: 'start_requested',
  };

  composite.record(event);

  assert.deepEqual(first.events, [event]);
  assert.deepEqual(second.events, [event]);
});
