import { useEffect, useState } from "react";
import type { Preview as PreviewData } from "../api";
import { navigateTabs } from "../tabs";

const show = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

export default function Preview({ data }: { data: PreviewData }) {
  const names = Object.keys(data.tables);
  const [tab, setTab] = useState(names[0] ?? "");
  const [raw, setRaw] = useState(false);
  const [focus, setFocus] = useState<{ table: string; column: string; value: unknown } | null>(null);
  const [note, setNote] = useState("");

  // A new preview may not contain the selected table any more.
  useEffect(() => {
    setTab((t) => (t in data.tables ? t : (Object.keys(data.tables)[0] ?? "")));
    setFocus(null);
    setNote("");
  }, [data]);

  const table = data.tables[tab];

  function jump(column: string, value: unknown) {
    const target = table?.refs[column];
    if (!target || value === null || value === undefined) return;
    const [parent, parentColumn] = target.split(".") as [string, string];
    const parentTable = data.tables[parent];
    if (!parentTable) {
      setNote(`${parent} is not part of this preview`);
      return;
    }
    setTab(parent);
    setFocus({ table: parent, column: parentColumn, value });
    setNote(parentTable.rows.some((r) => r[parentColumn] === value) ? "" : `${parent}.${parentColumn} = ${show(value)} is beyond the first ${parentTable.rows.length} rows`);
  }

  const pendingHere = (column: string) => data.pending.includes(`${tab}.${column}`);
  const isFocused = (row: Record<string, unknown>) => !!focus && focus.table === tab && row[focus.column] === focus.value;

  return (
    <div className="preview-body">
      {data.pending.length > 0 && (
        <div className="banner">
          {data.pending.length} LLM column{data.pending.length === 1 ? "" : "s"} not filled yet ({data.pending.join(", ")}): turn on “Fill LLM columns” to generate them.
        </div>
      )}
      <div className="preview-toolbar">
      <div className="tabs" role="tablist" aria-label="Generated tables" onKeyDown={navigateTabs}>
        {names.map((n) => (
          <button key={n} role="tab" tabIndex={n === tab ? 0 : -1} aria-selected={n === tab} className={n === tab ? "tab active" : "tab"} onClick={() => setTab(n)}>
            {n} <small>{data.counts[n] ?? 0}</small>
          </button>
        ))}
      </div>
        <button className="tab-raw" aria-pressed={raw} onClick={() => setRaw(!raw)}>
          {raw ? "Grid" : "Raw JSON"}
        </button>
      </div>
      {note && <div className="note">{note}</div>}
      {table && (
        <>
          <div className="muted">{`showing ${table.rows.length} of ${data.counts[tab] ?? table.rows.length}`}</div>
          {raw ? (
            <pre className="raw">{JSON.stringify(table.rows, null, 2)}</pre>
          ) : (
            <div className="grid">
              <table aria-label={`${tab} preview`}>
                <thead>
                  <tr>
                    {table.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, i) => (
                    <tr key={i} className={isFocused(row) ? "focus" : undefined} ref={(el) => (isFocused(row) ? el?.scrollIntoView?.({ block: "nearest" }) : undefined)}>
                      {table.columns.map((c) => (
                        <td key={c} title={show(row[c])}>
                          {pendingHere(c) && row[c] === null ? (
                            <span className="pending">pending</span>
                          ) : table.refs[c] && row[c] !== null ? (
                            <button className="fk" onClick={() => jump(c, row[c])}>
                              {show(row[c])}
                            </button>
                          ) : (
                            show(row[c])
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
