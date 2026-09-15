import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { KnowledgeCard } from "@testknowledge/model";
import { lexicalTokens, searchableText } from "@testknowledge/core";
import type { RetrievalHit, SearchIndex } from "@testknowledge/core";

type CardRow = { id: string; repo: string; revision: string; status: string; symbol: string; path: string };

function queryExpression(value: string): string {
  return lexicalTokens(value).map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

export class SqliteBm25fIndex implements SearchIndex {
  constructor(private readonly path: string) {}

  private ensureSchema(db: DatabaseSync): void {
    db.exec("CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, repo TEXT NOT NULL, revision TEXT NOT NULL, status TEXT NOT NULL, symbol TEXT NOT NULL, path TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS card_targets (id TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (id, target))");
    db.exec("CREATE INDEX IF NOT EXISTS card_targets_target ON card_targets (target)");
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(id UNINDEXED, symbol, path, title, trigger_text, statement, expected_behavior, oracle)");
  }

  async rebuild(cards: KnowledgeCard[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const db = new DatabaseSync(this.path);
    try {
      this.ensureSchema(db);
      db.exec("DELETE FROM cards");
      db.exec("DELETE FROM card_targets");
      db.exec("DELETE FROM cards_fts");
      const cardStmt = db.prepare("INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?)");
      const targetStmt = db.prepare("INSERT INTO card_targets VALUES (?, ?)");
      const ftsStmt = db.prepare("INSERT INTO cards_fts VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const card of cards) {
        cardStmt.run(card.id, card.repo, card.revision, card.status, card.symbol, card.path);
        for (const target of new Set([card.symbol, ...card.targetSymbols, ...card.applicability.symbols].filter(Boolean))) targetStmt.run(card.id, target);
        ftsStmt.run(
          card.id,
          searchableText(card.symbol),
          searchableText(card.path),
          searchableText(card.title),
          searchableText(card.trigger),
          searchableText(card.statement, ...card.techniques, ...(card.observed ? Object.values(card.observed).flat() : [])),
          searchableText(card.expectedBehavior),
          searchableText(card.oracle),
        );
      }
    } finally {
      db.close();
    }
  }

  async search(query: string, options: {
    repo: string;
    revision?: string;
    changedFiles: string[];
    targetSymbols: string[];
    includeCandidates: boolean;
    limit: number;
  }): Promise<RetrievalHit[]> {
    try {
      await stat(this.path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
    const db = new DatabaseSync(this.path);
    try {
      this.ensureSchema(db);
      const statuses = options.includeCandidates ? ["reviewed", "verified", "candidate"] : ["reviewed", "verified"];
      const statusPlaceholders = statuses.map(() => "?").join(",");
      const exact = new Map<string, RetrievalHit>();
      const addExact = (row: CardRow, field: string, score: number): void => {
        const old = exact.get(row.id);
        exact.set(row.id, old ? { ...old, matchedFields: [...new Set([...old.matchedFields, field])], score: Math.max(old.score, score) } : { id: row.id, channels: ["exact"], matchedFields: [field], score });
      };
      const commonArgs = [options.repo, ...(options.revision ? [options.revision] : []), ...statuses];
      if (options.targetSymbols.length > 0) {
        const symbols = [...new Set(options.targetSymbols)];
        const placeholders = symbols.map(() => "?").join(",");
        const directRows = db.prepare(`SELECT id,repo,revision,status,symbol,path FROM cards WHERE repo=? AND ${options.revision ? "revision=? AND " : ""} status IN (${statusPlaceholders}) AND symbol IN (${placeholders})`).all(...commonArgs, ...symbols) as unknown as CardRow[];
        for (const row of directRows) addExact(row, "symbol", 1.2);
        const targetRows = db.prepare(`SELECT DISTINCT c.id,c.repo,c.revision,c.status,c.symbol,c.path FROM cards c JOIN card_targets t ON t.id=c.id WHERE c.repo=? AND ${options.revision ? "c.revision=? AND " : ""} c.status IN (${statusPlaceholders}) AND t.target IN (${placeholders})`).all(...commonArgs, ...symbols) as unknown as CardRow[];
        for (const row of targetRows) addExact(row, "targetSymbols", 1.1);
      }
      if (options.changedFiles.length > 0) {
        const paths = [...new Set(options.changedFiles)];
        const placeholders = paths.map(() => "?").join(",");
        const pathRows = db.prepare(`SELECT id,repo,revision,status,symbol,path FROM cards WHERE repo=? AND ${options.revision ? "revision=? AND " : ""} status IN (${statusPlaceholders}) AND path IN (${placeholders})`).all(...commonArgs, ...paths) as unknown as CardRow[];
        for (const row of pathRows) addExact(row, "path", 1);
      }
      const expression = queryExpression(query);
      const lexical = new Map<string, RetrievalHit>();
      if (expression) {
        const rows = db.prepare(`SELECT f.id, bm25(cards_fts, 0, 5, 4, 3, 2, 1, 2, 2) AS rank FROM cards_fts f JOIN cards c ON c.id=f.id WHERE cards_fts MATCH ? AND c.repo=? AND ${options.revision ? "c.revision=? AND " : ""} c.status IN (${statusPlaceholders}) ORDER BY rank LIMIT ?`).all(expression, options.repo, ...(options.revision ? [options.revision] : []), ...statuses, options.limit * 4) as Array<{ id: string; rank: number }>;
        for (const [index, row] of rows.entries()) {
          lexical.set(row.id, { id: row.id, channels: ["bm25f"], matchedFields: ["text"], score: 1 / (index + 1) });
        }
      }
      const all = new Map<string, RetrievalHit>();
      for (const [id, hit] of exact) all.set(id, hit);
      for (const [id, hit] of lexical) {
        const old = all.get(id);
        all.set(id, old ? { ...old, channels: [...new Set([...old.channels, ...hit.channels])], matchedFields: [...new Set([...old.matchedFields, ...hit.matchedFields])], score: old.score + hit.score } : hit);
      }
      return [...all.values()].sort((a, b) => b.score - a.score).slice(0, options.limit);
    } finally {
      db.close();
    }
  }
}
