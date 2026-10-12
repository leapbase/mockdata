import { planGeneration, type DataSchemaT } from "@mockdata/core";
import { mapDbType, type DbKind, type RawTable } from "@mockdata/inputs";

export class SeedPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedPreflightError";
  }
}

export interface SeedPlan {
  tables: { name: string; columns: string[]; rows: number }[];
}

const fail = (message: string): never => { throw new SeedPreflightError(message); };
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Check exact raw catalog compatibility before generation or a database write. */
export function prepareSeedPlan(schema: DataSchemaT, catalog: RawTable[], _kind: DbKind): SeedPlan {
  const tables = new Map(catalog.map((table) => [table.name, table]));
  let generation;
  try {
    generation = planGeneration(schema);
  } catch (error) {
    return fail((error as Error).message);
  }
  if (generation.deferred.length) fail(`Foreign key cycle needs deferred links: ${generation.deferred.join(", ")}`);

  for (const [name, target] of Object.entries(schema.tables)) {
    const raw = tables.get(name) ?? fail(`Target table "${name}" was not found`);
    const columns = Object.keys(target.columns);
    const rawNames = raw.columns.map((column) => column.name);
    if (new Set(columns).size !== rawNames.length || columns.some((column) => !rawNames.includes(column))) {
      fail(`Table "${name}" columns differ from the target catalog`);
    }
    if (raw.primaryKey.length > 1 || raw.uniques.some((key) => key.length !== 1) || raw.foreignKeys.some((key) => key.columns.length !== 1 || key.refColumns.length !== 1)) {
      fail(`Table "${name}" has an unsupported composite or expression constraint`);
    }
    const expectedPk = columns.filter((column) => target.columns[column]!.primaryKey);
    if (!same(expectedPk, raw.primaryKey)) fail(`Table "${name}" primary key differs from the target catalog`);
    const expectedUnique = columns.filter((column) => target.columns[column]!.unique).sort();
    const rawUnique = raw.uniques.map((key) => key[0]!).sort();
    if (!same(expectedUnique, rawUnique)) fail(`Table "${name}" unique constraints differ from the target catalog`);

    for (const rawColumn of raw.columns) {
      const column = target.columns[rawColumn.name]!;
      const mapped = mapDbType(rawColumn.dataType, rawColumn.enumValues);
      if (mapped.note) fail(`Unsupported target type for ${name}.${rawColumn.name}: ${rawColumn.dataType}`);
      const expectedType = column.type === "email" ? "string" : column.type;
      if (mapped.type !== expectedType) fail(`Type mismatch for ${name}.${rawColumn.name}: ${rawColumn.dataType} vs ${column.type}`);
      if (rawColumn.nullable !== !!column.nullable && !column.primaryKey) fail(`Nullability mismatch for ${name}.${rawColumn.name}`);
      if (rawColumn.enumValues?.length && (!column.enum || column.enum.some((value) => !rawColumn.enumValues!.includes(String(value))))) {
        fail(`Enum mismatch for ${name}.${rawColumn.name}`);
      }
    }

    const expectedFks = columns.flatMap((column) => {
      const ref = target.columns[column]!.ref;
      if (!ref) return [];
      const [refTable, refColumn] = ref.split(".") as [string, string];
      return [{ columns: [column], refTable, refColumns: [refColumn] }];
    });
    for (const fk of raw.foreignKeys) {
      if (!schema.tables[fk.refTable]) fail(`Foreign key from "${name}" points outside generated schema to "${fk.refTable}"`);
      if (!expectedFks.some((expected) => same(expected.columns, fk.columns) && expected.refTable === fk.refTable && same(expected.refColumns, fk.refColumns))) {
        fail(`Foreign key mismatch for table "${name}"`);
      }
    }
    if (raw.foreignKeys.length !== expectedFks.length) fail(`Foreign key mismatch for table "${name}"`);
  }
  return { tables: generation.levels.flat().map((name) => ({
    name,
    columns: Object.keys(schema.tables[name]!.columns),
    rows: schema.tables[name]!.rows,
  })) };
}
