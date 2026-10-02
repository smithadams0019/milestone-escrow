import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, BatchWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export class Conflict extends Error { constructor() { super('version conflict'); this.code = 'CONFLICT'; } }

const PK = 'P#whitfield';

export function dynamoStore({ table, region = process.env.AWS_REGION || 'us-east-1' }) {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
  return {
    kind: 'dynamodb',
    async getProject() {
      const r = await doc.send(new GetCommand({ TableName: table, Key: { PK, SK: 'META' } }));
      return r.Item?.data || null;
    },
    /** Optimistic concurrency: the write succeeds only if the stored version equals project.version. */
    async putProject(project, { create = false } = {}) {
      const next = { ...project, version: project.version + 1 };
      try {
        await doc.send(new PutCommand({
          TableName: table, Item: { PK, SK: 'META', data: next, version: next.version },
          ConditionExpression: create ? 'attribute_not_exists(PK)' : '#v = :cur',
          ...(create ? {} : { ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':cur': project.version } }),
        }));
      } catch (e) { if (e.name === 'ConditionalCheckFailedException') throw new Conflict(); throw e; }
      return next;
    },
    async put(sk, data) { await doc.send(new PutCommand({ TableName: table, Item: { PK, SK: sk, data } })); return data; },
    /** Create-only write. Returns false if the key already exists (this is what makes ledger posting idempotent). */
    async putIfAbsent(sk, data) {
      try { await doc.send(new PutCommand({ TableName: table, Item: { PK, SK: sk, data }, ConditionExpression: 'attribute_not_exists(SK)' })); return true; }
      catch (e) { if (e.name === 'ConditionalCheckFailedException') return false; throw e; }
    },
    async get(sk) { const r = await doc.send(new GetCommand({ TableName: table, Key: { PK, SK: sk } })); return r.Item?.data || null; },
    async list(prefix, { limit = 200, reverse = false } = {}) {
      const r = await doc.send(new QueryCommand({
        TableName: table, KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
        ExpressionAttributeValues: { ':p': PK, ':s': prefix }, Limit: limit, ScanIndexForward: !reverse,
      }));
      return (r.Items || []).map((i) => i.data);
    },
    /** Atomic daily counter outside the project partition, so a reset cannot clear it. Returns false once over limit. */
    async bump(key, limit) {
      try {
        await doc.send(new UpdateCommand({
          TableName: table, Key: { PK: 'QUOTA', SK: key },
          UpdateExpression: 'ADD n :one SET expires = :exp', ConditionExpression: 'attribute_not_exists(n) OR n < :lim',
          ExpressionAttributeValues: { ':one': 1, ':lim': limit, ':exp': Math.floor(Date.now() / 1000) + 172800 },
        }));
        return true;
      } catch (e) { if (e.name === 'ConditionalCheckFailedException') return false; throw e; }
    },
    async wipe() {
      const r = await doc.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': PK }, ProjectionExpression: 'PK, SK' }));
      const keys = (r.Items || []).filter((i) => i.SK !== 'COUNTER');
      for (let i = 0; i < keys.length; i += 25) {
        await doc.send(new BatchWriteCommand({ RequestItems: { [table]: keys.slice(i, i + 25).map((k) => ({ DeleteRequest: { Key: { PK: k.PK, SK: k.SK } } })) } }));
      }
    },
  };
}

export function memoryStore() {
  const m = new Map();
  return {
    kind: 'memory',
    async getProject() { return m.get('META')?.data ?? null; },
    async putProject(project, { create = false } = {}) {
      const cur = m.get('META');
      if (create ? cur : (cur?.version ?? 0) !== project.version) throw new Conflict();
      const next = { ...project, version: project.version + 1 };
      m.set('META', { data: structuredClone(next), version: next.version });
      return next;
    },
    async put(sk, data) { m.set(sk, { data: structuredClone(data) }); return data; },
    async putIfAbsent(sk, data) { if (m.has(sk)) return false; m.set(sk, { data: structuredClone(data) }); return true; },
    async get(sk) { const r = m.get(sk); return r ? structuredClone(r.data) : null; },
    async list(prefix, { limit = 200, reverse = false } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (reverse) keys.reverse();
      return keys.slice(0, limit).map((k) => structuredClone(m.get(k).data));
    },
    async bump(key, limit) { const n = (m.get('Q' + key)?.data ?? 0); if (n >= limit) return false; m.set('Q' + key, { data: n + 1 }); return true; },
    async wipe() { for (const k of [...m.keys()]) if (!k.startsWith('Q')) m.delete(k); },
  };
}
