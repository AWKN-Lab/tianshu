import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  claimContentHash,
  type AppendClaimCommand,
  type ApplyClaimTransitionsCommand,
  type Claim,
} from '../../src/contracts/public.js';
import {
  ClaimRepositoryError,
  type ClaimRepositoryPort,
} from '../../src/context/public.js';

const id = (prefix: string, digit: string): string => `${prefix}_${digit.repeat(32)}`;
const now = '2026-07-27T04:00:00.000Z';
const later = '2026-07-27T04:01:00.000Z';

function claim(digit: string, content: string, overrides: Partial<Claim> = {}): Claim {
  return {
    schema: 'awkn-claim/v3',
    claimId: id('clm', digit),
    content,
    contentHash: claimContentHash(content),
    originator: 'human',
    speaker: 'human',
    claimType: 'fact',
    epistemicStatus: 'asserted',
    confirmationLevel: 'field',
    sourceRefs: [{
      schema: 'awkn-source-ref/v1',
      sourceKind: 'current_human_message',
      sourceId: `message-${digit}`,
      observedAt: now,
    }],
    derivedFrom: [],
    authority: 0.9,
    confidence: 0.9,
    sensitivityClass: 'internal',
    projectId: 'project-a',
    userId: 'user-a',
    validFrom: now,
    ...overrides,
  };
}

function appendCommand(
  item: Claim,
  digit: string,
  overrides: Partial<AppendClaimCommand> = {},
): AppendClaimCommand {
  return {
    schema: 'awkn-append-claim-command/v1',
    claim: item,
    eventId: id('evt', digit),
    idempotencyKey: `append-${digit}`,
    occurredAt: now,
    ...overrides,
  };
}

async function expectRepositoryError(
  action: () => Promise<unknown>,
  code: ClaimRepositoryError['code'],
): Promise<void> {
  await assert.rejects(action, (error: unknown) =>
    error instanceof ClaimRepositoryError && error.code === code);
}

export function claimRepositoryConformance(
  name: string,
  createRepository: () => ClaimRepositoryPort,
): void {
  describe(`ClaimRepositoryPort conformance: ${name}`, () => {
    it('appends idempotently and emits one event', async () => {
      const repository = createRepository();
      const item = claim('1', 'Budget is 200000');
      const command = appendCommand(item, '1');
      const first = await repository.append(command);
      const second = await repository.append(command);
      assert.deepEqual(second, first);
      assert.equal((await repository.eventsFor(item.claimId)).length, 1);
    });

    it('rejects idempotency reuse with a different command', async () => {
      const repository = createRepository();
      await repository.append(appendCommand(claim('1', 'A'), '1'));
      await expectRepositoryError(
        () => repository.append(appendCommand(claim('2', 'B'), '2', {
          idempotencyKey: 'append-1',
        })),
        'IDEMPOTENCY_CONFLICT',
      );
    });

    it('rejects the same claimId with different content', async () => {
      const repository = createRepository();
      const first = claim('1', 'A');
      await repository.append(appendCommand(first, '1'));
      const collision = claim('1', 'B');
      await expectRepositoryError(
        () => repository.append(appendCommand(collision, '2')),
        'CLAIM_ID_COLLISION',
      );
    });

    it('does not expose mutable internal records', async () => {
      const repository = createRepository();
      const item = claim('1', 'Original');
      const record = await repository.append(appendCommand(item, '1'));
      record.claim.content = 'Mutated outside repository';
      const stored = await repository.getById(item.claimId);
      assert.equal(stored?.claim.content, 'Original');
    });

    it('applies transition batches atomically under revision CAS', async () => {
      const repository = createRepository();
      const first = claim('1', 'A');
      const second = claim('2', 'B');
      await repository.append(appendCommand(first, '1'));
      await repository.append(appendCommand(second, '2'));

      const invalid: ApplyClaimTransitionsCommand = {
        schema: 'awkn-apply-claim-transitions-command/v1',
        idempotencyKey: 'transition-invalid',
        occurredAt: later,
        transitions: [
          {
            claimId: first.claimId,
            eventId: id('evt', '3'),
            expectedRevision: 0,
            toStatus: 'disputed',
            reasonCode: 'CONFLICT',
          },
          {
            claimId: second.claimId,
            eventId: id('evt', '4'),
            expectedRevision: 1,
            toStatus: 'disputed',
            reasonCode: 'CONFLICT',
          },
        ],
      };
      await expectRepositoryError(
        () => repository.applyTransitions(invalid),
        'REVISION_CONFLICT',
      );
      assert.equal((await repository.getById(first.claimId))?.revision, 0);
      assert.equal((await repository.getById(second.claimId))?.revision, 0);
      assert.equal((await repository.eventsFor(first.claimId)).length, 1);
    });

    it('applies a valid batch once and replays the same projection', async () => {
      const repository = createRepository();
      const first = claim('1', 'A');
      const second = claim('2', 'B');
      await repository.append(appendCommand(first, '1'));
      await repository.append(appendCommand(second, '2'));
      const command: ApplyClaimTransitionsCommand = {
        schema: 'awkn-apply-claim-transitions-command/v1',
        idempotencyKey: 'transition-valid',
        occurredAt: later,
        transitions: [
          {
            claimId: first.claimId,
            eventId: id('evt', '3'),
            expectedRevision: 0,
            toStatus: 'disputed',
            reasonCode: 'CONFLICT',
          },
          {
            claimId: second.claimId,
            eventId: id('evt', '4'),
            expectedRevision: 0,
            toStatus: 'superseded',
            reasonCode: 'DOMINATED',
          },
        ],
      };
      const firstResult = await repository.applyTransitions(command);
      const secondResult = await repository.applyTransitions(command);
      assert.deepEqual(secondResult, firstResult);
      assert.equal((await repository.eventsFor(first.claimId)).length, 2);
      assert.equal((await repository.eventsFor(second.claimId)).length, 2);
      assert.deepEqual(await repository.replay(first.claimId), await repository.getById(first.claimId));
      assert.deepEqual(await repository.replay(second.claimId), await repository.getById(second.claimId));
    });

    it('rejects transitions from terminal states', async () => {
      const repository = createRepository();
      const item = claim('1', 'A', { epistemicStatus: 'superseded' });
      await repository.append(appendCommand(item, '1'));
      await expectRepositoryError(
        () => repository.applyTransitions({
          schema: 'awkn-apply-claim-transitions-command/v1',
          idempotencyKey: 'transition-terminal',
          occurredAt: later,
          transitions: [{
            claimId: item.claimId,
            eventId: id('evt', '2'),
            expectedRevision: 0,
            toStatus: 'asserted',
            reasonCode: 'REOPEN',
          }],
        }),
        'INVALID_STATUS_TRANSITION',
      );
    });

    it('lists deterministically by scope and status', async () => {
      const repository = createRepository();
      const first = claim('2', 'B');
      const second = claim('1', 'A', { userId: 'user-b', epistemicStatus: 'disputed' });
      await repository.append(appendCommand(first, '2'));
      await repository.append(appendCommand(second, '1'));

      const project = await repository.list({ projectId: 'project-a', statuses: [] });
      assert.deepEqual(project.map((record) => record.claim.claimId), [second.claimId, first.claimId]);
      const asserted = await repository.list({
        projectId: 'project-a',
        statuses: ['asserted'],
      });
      assert.deepEqual(asserted.map((record) => record.claim.claimId), [first.claimId]);
      const user = await repository.list({ userId: 'user-b', statuses: [] });
      assert.deepEqual(user.map((record) => record.claim.claimId), [second.claimId]);
    });
  });
}
