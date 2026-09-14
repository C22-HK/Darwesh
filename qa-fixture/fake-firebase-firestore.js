// =====================================================================
// QA FIXTURE -- fake Firestore SDK, TEST-ONLY.
//
// Implements just enough of the modular Firestore JS SDK's surface
// (the exact named exports admin.html / js/firebase-init.js /
// js/notification-bell.js import from firebase-firestore.js) to let
// the real admin.html render against in-memory fixture data instead
// of a live Firestore connection. Never imported by production code --
// only served in place of the real gstatic module URL by
// qa-fixture/run-qa-screenshots.mjs's Playwright route interception,
// for local visual/functional QA of the Stage 3 table redesign.
//
// Writes (setDoc/updateDoc/addDoc/deleteDoc) mutate this in-memory
// table so bulk actions, role changes, and status toggles visibly
// take effect during an interactive QA run -- but nothing here ever
// touches a real Firestore database.
// =====================================================================
import { QA_USERS, QA_COMPANIES, QA_LISTINGS } from './fixtures.js';

const TABLES = {
  users: new Map(QA_USERS.map((u) => [u.uid, { ...u }])),
  companies: new Map(QA_COMPANIES.map((c) => [c.id, { ...c }])),
  listings: new Map(QA_LISTINGS.map((l) => [l.id, { ...l }])),
};
function tableFor(path) {
  if (!TABLES[path]) TABLES[path] = new Map();
  return TABLES[path];
}

export function getFirestore() { return { __qaDb: true }; }
export function initializeFirestore() { return { __qaDb: true }; }
export function persistentLocalCache() { return { __qaCache: true }; }
export function persistentMultipleTabManager() { return { __qaTabManager: true }; }
export function queryEqual() { return false; }

export function collection(_db, path, ...more) {
  return { __qaCollection: true, path: [path, ...more].join('/') };
}
export function collectionGroup(_db, name) { return { __qaCollectionGroup: true, name }; }
export function doc(dbOrColl, path, ...more) {
  if (dbOrColl && dbOrColl.__qaCollection) {
    const id = path || ('qa-auto-' + Math.random().toString(36).slice(2, 10));
    return { __qaDoc: true, collPath: dbOrColl.path, id };
  }
  const parts = [path, ...more];
  const id = parts.pop();
  return { __qaDoc: true, collPath: parts.join('/'), id };
}
export function query(base, ...constraints) { return { __qaQuery: true, base, constraints }; }
export function where(field, op, value) { return { __qaConstraint: 'where', field, op, value }; }
export function orderBy(field, dir) { return { __qaConstraint: 'orderBy', field, dir: dir || 'asc' }; }
export function limit(n) { return { __qaConstraint: 'limit', n }; }
export function startAfter() { return { __qaConstraint: 'startAfter' }; }
export function serverTimestamp() { return { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 }; }
export function deleteField() { return { __qaDeleteField: true }; }

function rowsFromRef(ref) {
  if (!ref) return [];
  if (ref.__qaCollectionGroup) return []; // subcollections (e.g. privateProfile) not modeled -- callers already handle empty gracefully
  if (ref.__qaCollection) {
    return [...tableFor(ref.path).entries()].map(([id, data]) => ({ id, data, collPath: ref.path }));
  }
  return [];
}
function applyConstraints(rows, constraints) {
  let out = rows;
  for (const c of constraints) {
    if (c.__qaConstraint === 'where') {
      out = out.filter((r) => {
        const v = r.data[c.field];
        switch (c.op) {
          case '==': return v === c.value;
          case '!=': return v !== c.value;
          case '<': return v < c.value;
          case '<=': return v <= c.value;
          case '>': return v > c.value;
          case '>=': return v >= c.value;
          case 'array-contains': return Array.isArray(v) && v.includes(c.value);
          case 'in': return Array.isArray(c.value) && c.value.includes(v);
          default: return true;
        }
      });
    } else if (c.__qaConstraint === 'orderBy') {
      out = [...out].sort((a, b) => {
        const av = a.data[c.field], bv = b.data[c.field];
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return c.dir === 'desc' ? -cmp : cmp;
      });
    } else if (c.__qaConstraint === 'limit') {
      out = out.slice(0, c.n);
    }
  }
  return out;
}
function resolveRows(refOrQuery) {
  if (refOrQuery && refOrQuery.__qaQuery) return applyConstraints(rowsFromRef(refOrQuery.base), refOrQuery.constraints);
  return rowsFromRef(refOrQuery);
}

function docSnapshot(id, data, collPath) {
  return {
    id,
    exists: () => data !== undefined,
    data: () => (data === undefined ? undefined : { ...data }),
    ref: { __qaDoc: true, collPath, id, parent: { id: collPath } },
  };
}

export async function getDocs(refOrQuery) {
  // Small deliberate delay -- lets the skeleton-row loading state (see
  // js/admin-table-kit.js's skeletonRows()) stay on screen long enough
  // for run-qa-screenshots.mjs to actually capture it, the same way an
  // in-flight real Firestore read would.
  await new Promise((r) => setTimeout(r, 220));
  const rows = resolveRows(refOrQuery);
  const docs = rows.map((r) => docSnapshot(r.id, r.data, r.collPath));
  return { empty: docs.length === 0, size: docs.length, docs, forEach(cb) { docs.forEach(cb); } };
}
export async function getDoc(docRef) {
  return docSnapshot(docRef.id, tableFor(docRef.collPath).get(docRef.id), docRef.collPath);
}
export async function getCountFromServer(refOrQuery) {
  const count = resolveRows(refOrQuery).length;
  return { data: () => ({ count }) };
}
export function onSnapshot(refOrQuery, cb) {
  getDocs(refOrQuery).then(cb);
  return () => {};
}

function applyDeleteFieldSentinels(merged) {
  for (const k of Object.keys(merged)) {
    if (merged[k] && merged[k].__qaDeleteField) delete merged[k];
  }
  return merged;
}
export async function setDoc(docRef, data, opts) {
  const table = tableFor(docRef.collPath);
  const prev = table.get(docRef.id) || {};
  table.set(docRef.id, applyDeleteFieldSentinels(opts && opts.merge ? { ...prev, ...data } : { ...data }));
}
export async function updateDoc(docRef, data) {
  const table = tableFor(docRef.collPath);
  table.set(docRef.id, applyDeleteFieldSentinels({ ...(table.get(docRef.id) || {}), ...data }));
}
export async function addDoc(collRef, data) {
  const table = tableFor(collRef.path);
  const id = 'qa-new-' + Math.random().toString(36).slice(2, 10);
  table.set(id, { ...data });
  return { id };
}
export async function deleteDoc(docRef) {
  tableFor(docRef.collPath).delete(docRef.id);
}
export async function runTransaction(_db, updateFn) {
  return updateFn({
    get: (ref) => getDoc(ref),
    set: (ref, data) => setDoc(ref, data),
    update: (ref, data) => updateDoc(ref, data),
  });
}
