import { getColumns, getTableName, eq, and } from "drizzle-orm";
import type { SQL, Column, Table } from "drizzle-orm";
import { z } from "zod/v4";
import { router, publicProcedure } from "../trpc/procedures.ts";
import { buildWhereConditions, type FilterInput } from "./filters.ts";
import {
  resolveLimit,
  buildCursorCondition,
  buildOrderBy,
  buildNextCursor,
} from "./pagination.ts";
import { evaluateRule } from "../rules/evaluator.ts";
import type { TableRules } from "../rules/types.ts";
import type { AnyDb } from "../core/db-types.ts";
import { TRPCError } from "@trpc/server";

export function generateCrudRouter(
  table: Table,
  db: AnyDb,
  tableRules?: TableRules,
) {
  const tableName = getTableName(table);
  const columns = getColumns(table);

  const idColumn = columns["id"] as Column | undefined;
  if (!idColumn) {
    throw new Error(
      `TSBase: Table "${tableName}" must have an "id" column for CRUD generation`,
    );
  }

  return router({
    list: publicProcedure
      .input(
        z
          .object({
            filter: z.record(z.string(), z.any()).optional(),
            cursor: z.string().optional(),
            limit: z.number().min(1).max(100).optional(),
            sort: z.string().optional(),
            order: z.enum(["asc", "desc"]).optional(),
          })
          .optional(),
      )
      .query(async ({ input, ctx }) => {
        // Evaluate access rule
        const ruleResult = await evaluateRule(tableRules?.list, {
          auth: ctx.auth,
        });
        if (!ruleResult.allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
        }

        const filter = (input?.filter ?? {}) as FilterInput;
        const limit = resolveLimit(input?.limit);
        const sortField = input?.sort;
        const order = input?.order ?? "asc";

        const sortColumn = sortField
          ? (columns[sortField] as Column | undefined)
          : undefined;

        // Build where conditions
        const allConditions: (SQL | undefined)[] = [];

        allConditions.push(
          buildWhereConditions(
            filter,
            columns as Record<string, Column>,
          ),
        );

        if (input?.cursor) {
          allConditions.push(
            buildCursorCondition(input.cursor, idColumn, sortColumn, order),
          );
        }

        // Add rule-injected WHERE clause
        if (ruleResult.whereClause) {
          allConditions.push(ruleResult.whereClause);
        }

        const conditions = allConditions.filter(Boolean) as SQL[];
        const where =
          conditions.length > 1
            ? and(...conditions)
            : conditions[0] ?? undefined;

        const orderBy = buildOrderBy(idColumn, sortColumn, order);

        const rows = await (ctx.db as any)
          .select()
          .from(table)
          .where(where)
          .orderBy(...orderBy)
          .limit(limit)
          ;

        const nextCursor = buildNextCursor(rows, limit, sortField);

        return {
          data: rows,
          nextCursor,
          hasMore: nextCursor !== null,
        };
      }),

    get: publicProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input, ctx }) => {
        const readRule = tableRules?.view ?? tableRules?.get;
        const ruleResult = await evaluateRule(readRule, {
          auth: ctx.auth,
          id: input.id,
        });
        if (!ruleResult.allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
        }

        const conditions: SQL[] = [eq(idColumn, input.id)];
        if (ruleResult.whereClause) conditions.push(ruleResult.whereClause);

        const where =
          conditions.length > 1 ? and(...conditions) : conditions[0];

        const rows = await (ctx.db as any).select().from(table).where(where);

        const row = rows[0];
        if (!row) return null;
        return row;
      }),

    create: publicProcedure
      .input(z.record(z.string(), z.any()))
      .mutation(async ({ input, ctx }) => {
        const ruleResult = await evaluateRule(tableRules?.create, {
          auth: ctx.auth,
        });
        if (!ruleResult.allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
        }

        const id =
          ((input as Record<string, unknown>).id as string | undefined) ??
          Bun.randomUUIDv7();
        const now = new Date().toISOString();

        const data: Record<string, unknown> = {
          ...(input as Record<string, unknown>),
          id,
          created_at: now,
          updated_at: now,
        };

        const insertData: Record<string, unknown> = {};
        for (const [key, col] of Object.entries(columns)) {
          const colName = (col as Column).name;
          if (key in data) {
            insertData[key] = data[key];
          } else if (colName in data) {
            insertData[key] = data[colName];
          }
        }

        await (ctx.db as any).insert(table).values(insertData);

        const rows = await (ctx.db as any)
          .select()
          .from(table)
          .where(eq(idColumn, id))
          ;

        return rows[0] ?? insertData;
      }),

    update: publicProcedure
      .input(
        z.object({
          id: z.string(),
          data: z.record(z.string(), z.any()),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const ruleResult = await evaluateRule(tableRules?.update, {
          auth: ctx.auth,
          id: input.id,
        });
        if (!ruleResult.allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
        }

        // If rule has WHERE clause, verify the record matches
        if (ruleResult.whereClause) {
          const check = await (ctx.db as any)
            .select()
            .from(table)
            .where(and(eq(idColumn, input.id), ruleResult.whereClause))
            ;
          if (check.length === 0) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Access denied",
            });
          }
        }

        const now = new Date().toISOString();
        const updateData: Record<string, unknown> = {
          ...(input.data as Record<string, unknown>),
          updated_at: now,
        };

        const filtered: Record<string, unknown> = {};
        for (const [key, col] of Object.entries(columns)) {
          const colName = (col as Column).name;
          if (key in updateData) {
            filtered[key] = updateData[key];
          } else if (colName in updateData) {
            filtered[key] = updateData[colName];
          }
        }

        await (ctx.db as any)
          .update(table)
          .set(filtered)
          .where(eq(idColumn, input.id))
          ;

        const rows = await (ctx.db as any)
          .select()
          .from(table)
          .where(eq(idColumn, input.id))
          ;

        return rows[0] ?? null;
      }),

    delete: publicProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const ruleResult = await evaluateRule(tableRules?.delete, {
          auth: ctx.auth,
          id: input.id,
        });
        if (!ruleResult.allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
        }

        // If rule has WHERE clause, verify the record matches
        if (ruleResult.whereClause) {
          const check = await (ctx.db as any)
            .select()
            .from(table)
            .where(and(eq(idColumn, input.id), ruleResult.whereClause))
            ;
          if (check.length === 0) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Access denied",
            });
          }
        }

        const rows = await (ctx.db as any)
          .select()
          .from(table)
          .where(eq(idColumn, input.id))
          ;

        if (rows.length === 0) return { deleted: false };

        await (ctx.db as any).delete(table).where(eq(idColumn, input.id));

        return { deleted: true };
      }),
  });
}

export function generateAllCrudRouters(
  schema: Record<string, unknown>,
  db: AnyDb,
  rules?: Record<string, TableRules>,
): Record<string, ReturnType<typeof router>> {
  const routers: Record<string, ReturnType<typeof router>> = {};

  for (const [key, table] of Object.entries(schema)) {
    if (typeof table !== "object" || table === null) continue;

    let tableName: string;
    try {
      tableName = getTableName(table as any);
    } catch {
      continue;
    }

    if (tableName.startsWith("_")) continue;

    try {
      routers[tableName] = generateCrudRouter(
        table as Table,
        db,
        rules?.[tableName],
      );
    } catch (err) {
      console.warn(
        `TSBase: Failed to generate CRUD for "${tableName}":`,
        err,
      );
    }
  }

  return routers;
}
