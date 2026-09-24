/* ============================================================================
   REV-EM — traduction PostgREST → SQL, pour tester les Edge Functions
   contre une VRAIE base PostgreSQL
   ----------------------------------------------------------------------------
   Supabase expose PostgREST ; les Edge Functions écrivent donc
   `db.from(t).update(...).eq(...).or(...).select(...)`. Ce fichier traduit ce
   sous-ensemble — exactement celui que le code de REV-EM utilise, pas un de
   plus — en SQL réellement exécuté par PostgreSQL.

   Pourquoi ce n'est PAS un faux client : les contraintes d'unicité, les clés
   étrangères, les policies RLS, l'atomicité des UPDATE conditionnels et la
   sérialisation des transactions concurrentes sont celles de PostgreSQL. Ce
   qui est remplacé, c'est le transport HTTP, pas la base.

   Ce qui reste hors de portée : PostgREST lui-même (analyse des paramètres
   d'URL, negotiation de contenu) et l'infrastructure Supabase (Auth, secrets,
   déploiement). Voir le rapport de l'étape 5.
   ============================================================================ */
"use strict";

function quoteIdent(s) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(String(s))) throw new Error("Identifiant refusé : " + s);
  return '"' + s + '"';
}

/* Colonnes d'un `select("a,b,c")`. "*" et "" → toutes. */
function columnList(cols) {
  const c = String(cols || "*").trim();
  if (!c || c === "*") return "*";
  return c.split(",").map(x => quoteIdent(x.trim())).join(", ");
}

/* `or("refresh_lock_at.is.null,refresh_lock_at.lt.2026-01-01T00:00:00Z")` */
function parseOr(expr, params) {
  const parts = String(expr).split(",").map(s => s.trim()).filter(Boolean);
  const sql = parts.map(p => {
    const first = p.indexOf(".");
    const second = p.indexOf(".", first + 1);
    const col = p.slice(0, first);
    const op = p.slice(first + 1, second === -1 ? undefined : second);
    const val = second === -1 ? "" : p.slice(second + 1);
    if (op === "is") return `${quoteIdent(col)} is null`;
    params.push(val);
    if (op === "lt") return `${quoteIdent(col)} < $${params.length}`;
    if (op === "gt") return `${quoteIdent(col)} > $${params.length}`;
    if (op === "eq") return `${quoteIdent(col)} = $${params.length}`;
    throw new Error("Opérateur `or` non pris en charge : " + op);
  });
  return "(" + sql.join(" or ") + ")";
}

/* `run` : (sql, params) => Promise<rows>. Injecté pour que l'appelant décide
   du rôle SQL (service_role pour les Edge Functions, authenticated pour un
   accès client) et de la connexion utilisée. */
function createPostgrestClient(run, opts = {}) {
  const schema = opts.schema || "public";

  function from(table) {
    const st = {
      table, op: null, payload: null, filters: [], orFilters: [],
      selectCols: null, single: false, onConflict: null,
      order: null, limit: null,
    };

    async function execute() {
      const params = [];
      const where = [];
      for (const f of st.filters) {
        if (f.kind === "is") { where.push(`${quoteIdent(f.col)} is null`); continue; }
        /* `in` prend une LISTE : chaque élément devient son propre paramètre.
           (L'implémentation précédente poussait d'abord le tableau entier puis
           retirait le dernier élément, ce qui laissait un placeholder sans
           valeur — le filtre échouait dès qu'il était réellement utilisé.) */
        if (f.kind === "in") {
          const list = (f.val || []).map(v => { params.push(v); return "$" + params.length; });
          where.push(list.length ? `${quoteIdent(f.col)} = any(array[${list.join(",")}])` : "false");
          continue;
        }
        params.push(f.val);
        const p = "$" + params.length;
        if (f.kind === "eq") where.push(`${quoteIdent(f.col)} = ${p}`);
        else if (f.kind === "neq") where.push(`${quoteIdent(f.col)} <> ${p}`);
        else if (f.kind === "lt") where.push(`${quoteIdent(f.col)} < ${p}`);
        else if (f.kind === "gt") where.push(`${quoteIdent(f.col)} > ${p}`);
      }
      for (const o of st.orFilters) where.push(parseOr(o, params));
      const whereSql = where.length ? " where " + where.join(" and ") : "";
      const rel = `${quoteIdent(schema)}.${quoteIdent(st.table)}`;

      let sql;
      if (st.op === "select") {
        sql = `select ${columnList(st.selectCols)} from ${rel}${whereSql}`;
        if (st.order) sql += ` order by ${quoteIdent(st.order.col)} ${st.order.asc ? "asc" : "desc"}`;
        if (st.limit) sql += ` limit ${Number(st.limit)}`;
      } else if (st.op === "insert" || st.op === "upsert") {
        /* Le vrai client accepte une ligne OU un tableau de lignes, et REV-EM
           écrit par paquets : on prend les deux. Toutes les lignes d'un même
           appel doivent porter les mêmes colonnes — c'est le cas du code
           appelant, qui construit ses lignes depuis un même gabarit. */
        const rows = Array.isArray(st.payload) ? st.payload : [st.payload];
        if (!rows.length) return { data: [], error: null, count: 0 };
        const cols = Object.keys(rows[0]);
        const tuples = rows.map(row =>
          "(" + cols.map(c => { params.push(normalize(row[c], c)); return "$" + params.length; }).join(", ") + ")");
        sql = `insert into ${rel} (${cols.map(quoteIdent).join(", ")}) values ${tuples.join(", ")}`;
        if (st.op === "upsert") {
          const keys = String(st.onConflict || "id").split(",").map(s => s.trim());
          const conflict = keys.map(quoteIdent).join(", ");
          const updatable = cols.filter(c => !keys.includes(c));
          sql += ` on conflict (${conflict}) do update set ` +
                 (updatable.length ? updatable.map(c => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`).join(", ")
                                   : `${quoteIdent(cols[0])} = excluded.${quoteIdent(cols[0])}`);
        }
        sql += ` returning ${columnList(st.selectCols)}`;
      } else if (st.op === "update") {
        const cols = Object.keys(st.payload);
        const sets = cols.map(c => { params.push(normalize(st.payload[c])); return `${quoteIdent(c)} = $${params.length}`; });
        // Les filtres ont été numérotés avant : on reconstruit dans le bon ordre.
        return await executeUpdate(rel, st, run, columnList(st.selectCols));
      } else if (st.op === "delete") {
        sql = `delete from ${rel}${whereSql} returning ${columnList(st.selectCols)}`;
      } else {
        throw new Error("Opération non prise en charge : " + st.op);
      }

      try {
        const rows = await run(sql, params);
        const data = st.single ? (rows[0] ?? null) : rows;
        return { data, error: null, count: rows.length };
      } catch (e) {
        return { data: null, error: toPostgrestError(e), count: null };
      }
    }

    const b = {
      select(cols) { if (!st.op) st.op = "select"; st.selectCols = cols || "*"; return b; },
      insert(row) { st.op = "insert"; st.payload = row; return b; },
      upsert(row, o) { st.op = "upsert"; st.payload = row; st.onConflict = o && o.onConflict; return b; },
      update(patch) { st.op = "update"; st.payload = patch; return b; },
      delete() { st.op = "delete"; return b; },
      eq(c, v) { st.filters.push({ kind: "eq", col: c, val: v }); return b; },
      neq(c, v) { st.filters.push({ kind: "neq", col: c, val: v }); return b; },
      lt(c, v) { st.filters.push({ kind: "lt", col: c, val: v }); return b; },
      gt(c, v) { st.filters.push({ kind: "gt", col: c, val: v }); return b; },
      is(c) { st.filters.push({ kind: "is", col: c }); return b; },
      in(c, arr) { st.filters.push({ kind: "in", col: c, val: arr }); return b; },
      or(expr) { st.orFilters.push(expr); return b; },
      order(col, o) { st.order = { col, asc: !(o && o.ascending === false) }; return b; },
      limit(n) { st.limit = n; return b; },
      maybeSingle() { st.single = true; return b; },
      single() { st.single = true; return b; },
      then(res, rej) { return execute().then(res, rej); },
    };
    return b;
  }

  return { from, schema: () => createPostgrestClient(run, { schema: "public" }) };
}

/* L'UPDATE doit numéroter ses paramètres SET avant ceux du WHERE : on le
   construit séparément pour ne pas mélanger les deux séries. */
async function executeUpdate(rel, st, run, returning) {
  const params = [];
  const sets = Object.keys(st.payload).map(c => {
    params.push(normalize(st.payload[c], c));
    return `${quoteIdent(c)} = $${params.length}`;
  });
  const where = [];
  for (const f of st.filters) {
    if (f.kind === "is") { where.push(`${quoteIdent(f.col)} is null`); continue; }
    params.push(f.val);
    const p = "$" + params.length;
    if (f.kind === "eq") where.push(`${quoteIdent(f.col)} = ${p}`);
    else if (f.kind === "neq") where.push(`${quoteIdent(f.col)} <> ${p}`);
    else if (f.kind === "lt") where.push(`${quoteIdent(f.col)} < ${p}`);
    else where.push("true");
  }
  for (const o of st.orFilters) where.push(parseOr(o, params));
  const sql = `update ${rel} set ${sets.join(", ")}` +
              (where.length ? " where " + where.join(" and ") : "") +
              ` returning ${returning}`;
  try {
    const rows = await run(sql, params);
    return { data: st.single ? (rows[0] ?? null) : rows, error: null, count: rows.length };
  } catch (e) {
    return { data: null, error: toPostgrestError(e), count: null };
  }
}

/* Les seules colonnes RÉELLEMENT de type tableau PostgreSQL (`text[]`) du
   schéma. Partout ailleurs, un tableau JavaScript vise une colonne `jsonb` et
   doit donc partir sérialisé : envoyé tel quel, node-postgres l'écrirait sous
   la forme littérale `{a,b}` d'un tableau SQL, que `jsonb` refuse.
   Se tromper de côté est silencieux à l'écriture et faux à la lecture —
   d'où la liste explicite plutôt qu'une heuristique. */
const SQL_ARRAY_COLUMNS = new Set(["scopes"]);

function normalize(v, col) {
  if (v === undefined) return null;
  if (Array.isArray(v)) return SQL_ARRAY_COLUMNS.has(col) ? v : JSON.stringify(v);
  if (v && typeof v === "object") return JSON.stringify(v);
  return v;
}

function toPostgrestError(e) {
  return {
    code: e.code || "unknown",
    message: e.message || String(e),
    details: e.detail || null,
    hint: e.hint || null,
  };
}

module.exports = { createPostgrestClient };
