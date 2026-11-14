import { isMap, isScalar, LineCounter, parseDocument, visit, YAMLParseError } from "yaml";

/**
 * `yaml.parse`, minus its quadratic duplicate-key check: the library compares every key of a map with every
 * earlier one, so a 1 MB document with one large map held the event loop for five seconds. Duplicates are still
 * refused, here in one pass with a Set per map.
 */
export function parseYamlLinear(text: string): unknown {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { uniqueKeys: false, lineCounter });
  if (doc.errors.length > 0) throw doc.errors[0];
  visit(doc, {
    Map(_key, map) {
      if (!isMap(map)) return;
      const seen = new Set<string>();
      for (const pair of map.items) {
        const key = pair.key;
        if (!isScalar(key) || key.value === "<<") continue; // merge keys may repeat
        const id = `${typeof key.value}:${String(key.value)}`;
        if (seen.has(id)) {
          const at = key.range?.[0] ?? 0;
          const error = new YAMLParseError([at, at + 1], "DUPLICATE_KEY", "Map keys must be unique");
          error.linePos = [lineCounter.linePos(at)];
          error.message += ` at line ${error.linePos[0].line}, column ${error.linePos[0].col}`;
          throw error;
        }
        seen.add(id);
      }
    },
  });
  return doc.toJS();
}
