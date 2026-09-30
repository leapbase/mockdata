import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";

// The README documents these files; this keeps every one of them working.
const examples = join(__dirname, "../../../examples");
const empty = mkdtempSync(join(tmpdir(), "mockdata-examples-cwd-"));

async function exec(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await run(argv, { out: (s) => (out += s), err: (s) => (err += s), llm: { env: {} }, cwd: empty });
  return { code, out, err };
}
const json = async (...argv: string[]) => {
  const r = await exec(...argv);
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out);
};

describe("every example schema validates", () => {
  const files = readdirSync(examples).filter((f) => f.endsWith(".yaml") && f !== "petstore-openapi.yaml");
  it.each(files)("%s", async (file) => {
    const r = await exec("validate", join(examples, file));
    expect(r.code, r.err).toBe(0);
  });
});

describe("shop.yaml", () => {
  it("generates the documented row counts", async () => {
    const data = await json("generate", join(examples, "shop.yaml"));
    expect(Object.fromEntries(Object.entries(data).map(([t, r]) => [t, (r as unknown[]).length]))).toEqual({ customers: 20, orders: 100 });
  });
});

const perParent = (rows: Record<string, any>[], key: string) => {
  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r[key], (counts.get(r[key]) ?? 0) + 1);
  return Math.max(...counts.values());
};
const byId = (rows: Record<string, any>[]) => new Map(rows.map((r) => [r.id, r]));

describe("clinical-ehr.yaml", () => {
  it("produces data that satisfies every feature it demonstrates", async () => {
    const d = await json("generate", join(examples, "clinical-ehr.yaml"));
    expect(Object.fromEntries(Object.entries(d).map(([t, r]) => [t, (r as unknown[]).length]))).toEqual({
      patients: 25, providers: 6, insurance_policies: 20, encounters: 60, diagnoses: 120, medications: 90, lab_results: 150,
    });
    const mrns = d.patients.map((p: any) => p.mrn);
    for (const m of mrns) expect(m).toMatch(/^MRN-[0-9]{7}$/);
    expect(new Set(mrns).size).toBe(mrns.length);
    // dates reach through a foreign key to the parent row
    const patients = byId(d.patients);
    for (const e of d.encounters) expect(e.admitted_at >= patients.get(e.patient_id).dob).toBe(true);
    const encounters = byId(d.encounters);
    for (const e of d.encounters) if (e.discharged_at) expect(e.discharged_at >= e.admitted_at).toBe(true);
    for (const m of d.medications) expect(m.started_at >= encounters.get(m.encounter_id).admitted_at).toBe(true);
    for (const l of d.lab_results) expect(l.collected_at >= encounters.get(l.encounter_id).admitted_at).toBe(true);
    // one-to-one and per-parent cap
    const covered = d.insurance_policies.map((p: any) => p.patient_id);
    expect(new Set(covered).size).toBe(covered.length);
    expect(perParent(d.diagnoses, "encounter_id")).toBeLessThanOrEqual(5);
  });
});

describe("clinical-trial.yaml", () => {
  it("produces data that satisfies every feature it demonstrates", async () => {
    const d = await json("generate", join(examples, "clinical-trial.yaml"));
    const codes = d.subjects.map((s: any) => s.subject_code);
    for (const c of codes) expect(c).toMatch(/^[A-Z]{3}-[0-9]{4}$/);
    expect(new Set(codes).size).toBe(codes.length);
    const subjects = byId(d.subjects);
    for (const v of d.visits) expect(v.visit_date >= subjects.get(v.subject_id).consented_on).toBe(true);
    for (const a of d.adverse_events) {
      expect(a.onset >= subjects.get(a.subject_id).consented_on).toBe(true);
      if (a.resolved_on) expect(a.resolved_on >= a.onset).toBe(true);
    }
    expect(d.adverse_events.some((a: any) => a.resolved_on === null)).toBe(true);
    expect(perParent(d.adverse_events, "subject_id")).toBeLessThanOrEqual(4);
  });
});

describe("clinical-claims.yaml", () => {
  it("produces data that satisfies every feature it demonstrates", async () => {
    const d = await json("generate", join(examples, "clinical-claims.yaml"));
    for (const c of d.claims) {
      expect(c.submitted_at >= c.service_date).toBe(true);
      if (c.paid_at) expect(c.paid_at >= c.submitted_at).toBe(true);
      expect(["submitted", "paid", "denied"]).toContain(c.status);
    }
    expect(d.claims.some((c: any) => c.paid_at === null)).toBe(true);
    expect(perParent(d.claim_lines, "claim_id")).toBeLessThanOrEqual(6);
  });
});

describe("clinical-rwd-omop.yaml", () => {
  it("produces data that satisfies every feature it demonstrates", async () => {
    const d = await json("generate", join(examples, "clinical-rwd-omop.yaml"));
    expect(Object.fromEntries(Object.entries(d).map(([t, r]) => [t, (r as unknown[]).length]))).toEqual({
      person: 40, observation_period: 40, visit_occurrence: 120, condition_occurrence: 150, drug_exposure: 180,
      measurement_hba1c: 80, measurement_heart_rate: 100, measurement_blood_pressure: 100, measurement_bmi: 60, death: 5,
    });
    for (const p of d.person) {
      expect([8507, 8532]).toContain(p.gender_concept_id);
      expect(p.person_source_value).toMatch(/^PT-[0-9]{8}$/);
    }
    const people = new Map<number, any>(d.person.map((p: any) => [p.person_id, p]));
    // one observation period per person, inside the person's lifetime order
    const periodOwners = d.observation_period.map((o: any) => o.person_id);
    expect(new Set(periodOwners).size).toBe(periodOwners.length);
    for (const o of d.observation_period) {
      expect(o.observation_period_start_date >= people.get(o.person_id).birth_date).toBe(true);
      expect(o.observation_period_end_date >= o.observation_period_start_date).toBe(true);
    }
    // events follow their visit
    const visits = new Map<number, any>(d.visit_occurrence.map((v: any) => [v.visit_occurrence_id, v]));
    for (const v of d.visit_occurrence) {
      expect(v.visit_start_date >= people.get(v.person_id).birth_date).toBe(true);
      expect(v.visit_end_date >= v.visit_start_date).toBe(true);
    }
    for (const c of d.condition_occurrence) {
      expect(c.condition_start_date >= visits.get(c.visit_occurrence_id).visit_start_date).toBe(true);
      if (c.condition_end_date) expect(c.condition_end_date >= c.condition_start_date).toBe(true);
    }
    expect(d.condition_occurrence.some((c: any) => c.condition_end_date === null)).toBe(true);
    for (const x of d.drug_exposure) {
      expect(x.drug_exposure_start_date >= visits.get(x.visit_occurrence_id).visit_start_date).toBe(true);
      expect(x.drug_exposure_end_date >= x.drug_exposure_start_date).toBe(true);
    }
    // dates stay close to their visit (within), so a stay is never years long
    const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 86_400_000;
    for (const v of d.visit_occurrence) expect(days(v.visit_end_date, v.visit_start_date)).toBeLessThanOrEqual(14);
    for (const c of d.condition_occurrence) expect(days(c.condition_start_date, visits.get(c.visit_occurrence_id).visit_start_date)).toBeLessThanOrEqual(14);
    for (const x of d.drug_exposure) expect(days(x.drug_exposure_end_date, x.drug_exposure_start_date)).toBeLessThanOrEqual(90);
    // each measurement table has plausible values and its own unit
    const checks: [string, string, number, number, string][] = [
      ["measurement_hba1c", "value_as_number", 4, 14, "%"],
      ["measurement_heart_rate", "value_as_number", 45, 140, "bpm"],
      ["measurement_bmi", "value_as_number", 15, 45, "kg/m2"],
    ];
    for (const [table, col, lo, hi, unit] of checks) {
      for (const m of d[table]) {
        expect(m[col]).toBeGreaterThanOrEqual(lo);
        expect(m[col]).toBeLessThanOrEqual(hi);
        expect(m.unit_source_value).toBe(unit);
      }
    }
    for (const m of d.measurement_blood_pressure) {
      expect(m.systolic).toBeGreaterThan(m.diastolic);
      expect(m.unit_source_value).toBe("mmHg");
    }
    for (const t of ["measurement_hba1c", "measurement_heart_rate", "measurement_blood_pressure", "measurement_bmi"]) {
      for (const m of d[t]) {
        expect(m.measurement_date >= visits.get(m.visit_occurrence_id).visit_start_date).toBe(true);
        expect(days(m.measurement_date, visits.get(m.visit_occurrence_id).visit_start_date)).toBeLessThanOrEqual(14);
      }
    }
    expect(perParent(d.condition_occurrence, "visit_occurrence_id")).toBeLessThanOrEqual(4);
    // deaths: one per person, after birth
    const dead = d.death.map((x: any) => x.person_id);
    expect(new Set(dead).size).toBe(dead.length);
    for (const x of d.death) expect(x.death_date >= people.get(x.person_id).birth_date).toBe(true);
  });
});

describe("clinical-sdtm.yaml", () => {
  it("produces data that satisfies every feature it demonstrates", async () => {
    const d = await json("generate", join(examples, "clinical-sdtm.yaml"));
    expect(Object.fromEntries(Object.entries(d).map(([t, r]) => [t, (r as unknown[]).length]))).toEqual({
      DM: 40, EX: 100, AE: 50, DS: 40, LB_HGB: 80, LB_ALT: 80, LB_CREAT: 80, VS_BP: 100, VS_PULSE: 100, ADSL: 40,
    });
    const ids = d.DM.map((s: any) => s.USUBJID);
    for (const id of ids) expect(id).toMatch(/^ABC101-[0-9]{7}$/);
    expect(new Set(ids).size).toBe(ids.length);
    const subjects = new Map<string, any>(d.DM.map((s: any) => [s.USUBJID, s]));
    const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 86_400_000;
    for (const s of d.DM) expect(days(s.RFENDTC, s.RFSTDTC)).toBeGreaterThanOrEqual(0);

    // every event date follows the subject's first dose and stays within its bound
    const dated: [string, string, number][] = [
      ["EX", "EXSTDTC", 14], ["AE", "AESTDTC", 150], ["DS", "DSSTDTC", 180], ["LB_HGB", "LBDTC", 180], ["LB_ALT", "LBDTC", 180],
      ["LB_CREAT", "LBDTC", 180], ["VS_BP", "VSDTC", 180], ["VS_PULSE", "VSDTC", 180], ["ADSL", "TRTSDT", 7],
    ];
    for (const [table, col, bound] of dated) {
      for (const r of d[table]) {
        expect(subjects.has(r.USUBJID), `${table} orphan`).toBe(true);
        const gap = days(r[col], subjects.get(r.USUBJID).RFSTDTC);
        expect(gap, `${table}.${col}`).toBeGreaterThanOrEqual(0);
        expect(gap, `${table}.${col}`).toBeLessThanOrEqual(bound);
      }
    }
    for (const a of d.AE) if (a.AEENDTC) expect(days(a.AEENDTC, a.AESTDTC)).toBeGreaterThanOrEqual(0);
    expect(d.AE.some((a: any) => a.AEENDTC === null)).toBe(true);

    // caps and one-to-one
    expect(perParent(d.AE, "USUBJID")).toBeLessThanOrEqual(4);
    expect(perParent(d.EX, "USUBJID")).toBeLessThanOrEqual(6);
    for (const t of ["DS", "ADSL"]) expect(new Set(d[t].map((r: any) => r.USUBJID)).size).toBe(d[t].length);

    // controlled terms, ranges and units
    for (const a of d.AE) {
      expect(["MILD", "MODERATE", "SEVERE"]).toContain(a.AESEV);
      expect(["Y", "N"]).toContain(a.AESER);
    }
    const ranges: [string, string, number, number, string][] = [
      ["LB_HGB", "LBORRES", 8, 18, "g/dL"], ["LB_ALT", "LBORRES", 5, 200, "U/L"], ["LB_CREAT", "LBORRES", 0.4, 3, "mg/dL"],
      ["VS_PULSE", "PULSE", 45, 140, "beats/min"],
    ];
    for (const [table, col, lo, hi, unit] of ranges) {
      for (const r of d[table]) {
        expect(r[col]).toBeGreaterThanOrEqual(lo);
        expect(r[col]).toBeLessThanOrEqual(hi);
        expect(r.LBORRESU ?? r.VSORRESU).toBe(unit);
      }
    }
    for (const r of d.VS_BP) expect(r.SYSBP).toBeGreaterThan(r.DIABP);
  });
});

describe("pharmacovigilance.yaml", () => {
  it("produces data that satisfies every feature it demonstrates", async () => {
    const d = await json("generate", join(examples, "pharmacovigilance.yaml"));
    expect(Object.fromEntries(Object.entries(d).map(([t, r]) => [t, (r as unknown[]).length]))).toEqual({
      products: 6, cases: 60, suspect_drugs: 90, reactions: 110, follow_ups: 40,
    });
    const ids = d.cases.map((c: any) => c.case_id);
    for (const id of ids) expect(id).toMatch(/^US-2024-[0-9]{6}$/);
    expect(new Set(ids).size).toBe(ids.length);
    const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 86_400_000;
    // the chain of dates on each case
    for (const c of d.cases) {
      expect(days(c.event_onset_date, c.first_drug_date)).toBeGreaterThanOrEqual(0);
      expect(days(c.event_onset_date, c.first_drug_date)).toBeLessThanOrEqual(90);
      expect(days(c.receipt_date, c.event_onset_date)).toBeGreaterThanOrEqual(0);
      expect(days(c.receipt_date, c.event_onset_date)).toBeLessThanOrEqual(120);
    }
    const cases = byId(d.cases);
    for (const s of d.suspect_drugs) {
      const gap = days(s.start_date, cases.get(s.case_id).first_drug_date);
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(30);
    }
    for (const f of d.follow_ups) {
      const gap = days(f.follow_up_date, cases.get(f.case_id).receipt_date);
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(90);
    }
    // caps
    expect(perParent(d.suspect_drugs, "case_id")).toBeLessThanOrEqual(3);
    expect(perParent(d.reactions, "case_id")).toBeLessThanOrEqual(5);
    expect(perParent(d.follow_ups, "case_id")).toBeLessThanOrEqual(3);
    // reports are concentrated on a few products (zipf)
    expect(perParent(d.suspect_drugs, "product_id")).toBeGreaterThan(90 / 6);
    for (const r of d.reactions) expect(["certain", "probable", "possible", "unlikely", "unassessable"]).toContain(r.causality);
  });
});

describe("manufacturing-quality.yaml", () => {
  it("produces data that satisfies every feature it demonstrates", async () => {
    const d = await json("generate", join(examples, "manufacturing-quality.yaml"));
    expect(Object.fromEntries(Object.entries(d).map(([t, r]) => [t, (r as unknown[]).length]))).toEqual({
      products: 5, raw_material_lots: 15, batches: 40, batch_materials: 100, qc_assay: 40, qc_dissolution: 40, qc_moisture: 40,
      stability_studies: 20, stability_results: 60, deviations: 25, capas: 20, equipment: 8, calibrations: 30,
    });
    for (const b of d.batches) expect(b.batch_no).toMatch(/^B[0-9]{7}$/);
    for (const l of d.raw_material_lots) expect(l.lot_no).toMatch(/^L[0-9]{8}$/);
    expect(new Set(d.batches.map((b: any) => b.batch_no)).size).toBe(d.batches.length);
    const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 86_400_000;
    const between = (gap: number, max: number) => {
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(max);
    };
    for (const l of d.raw_material_lots) between(days(l.expiry_on, l.received_on), 730);
    const batches = byId(d.batches);
    for (const b of d.batches) between(days(b.expiry_on, b.manufactured_on), 1095);
    // every lot predates every batch, so traceability is consistent by construction
    const lastReceived = Math.max(...d.raw_material_lots.map((l: any) => Date.parse(l.received_on)));
    for (const b of d.batches) expect(Date.parse(b.manufactured_on)).toBeGreaterThan(lastReceived);
    expect(perParent(d.batch_materials, "batch_id")).toBeLessThanOrEqual(6);
    // QC: each table has its own range and is tested soon after manufacture
    const qc: [string, string, number, number][] = [
      ["qc_assay", "result_pct_label_claim", 90, 110], ["qc_dissolution", "result_pct_dissolved_30min", 70, 100], ["qc_moisture", "result_pct_water", 0.1, 5],
    ];
    for (const [table, col, lo, hi] of qc) {
      for (const r of d[table]) {
        expect(r[col]).toBeGreaterThanOrEqual(lo);
        expect(r[col]).toBeLessThanOrEqual(hi);
        between(days(r.tested_on, batches.get(r.batch_id).manufactured_on), 30);
      }
    }
    // stability
    const studies = byId(d.stability_studies);
    for (const s of d.stability_studies) between(days(s.started_on, batches.get(s.batch_id).manufactured_on), 30);
    for (const r of d.stability_results) between(days(r.tested_on, studies.get(r.study_id).started_on), 730);
    expect(perParent(d.stability_studies, "batch_id")).toBeLessThanOrEqual(2);
    // deviations and CAPAs: chains of dates, and some items still open
    const deviations = byId(d.deviations);
    for (const v of d.deviations) {
      between(days(v.opened_on, batches.get(v.batch_id).manufactured_on), 60);
      if (v.closed_on) between(days(v.closed_on, v.opened_on), 90);
    }
    for (const c of d.capas) {
      between(days(c.opened_on, deviations.get(c.deviation_id).opened_on), 30);
      between(days(c.due_on, c.opened_on), 120);
      if (c.closed_on) between(days(c.closed_on, c.opened_on), 180);
    }
    expect(d.deviations.some((v: any) => v.closed_on === null)).toBe(true);
    expect(d.capas.some((c: any) => c.closed_on === null)).toBe(true);
    expect(perParent(d.capas, "deviation_id")).toBeLessThanOrEqual(2);
    for (const c of d.calibrations) between(days(c.next_due_on, c.calibrated_on), 365);
    expect(perParent(d.calibrations, "equipment_id")).toBeLessThanOrEqual(6);
  });
});

describe("supply-chain.yaml", () => {
  it("produces data that satisfies every feature it demonstrates", async () => {
    const d = await json("generate", join(examples, "supply-chain.yaml"));
    expect(Object.fromEntries(Object.entries(d).map(([t, r]) => [t, (r as unknown[]).length]))).toEqual({
      products: 5, manufacturers: 4, wholesalers: 6, pharmacies: 20, packs: 80, wholesale_receipts: 60, pharmacy_receipts: 45, dispensing: 30, investigations: 6,
    });
    for (const p of d.products) expect(p.gtin).toMatch(/^0[0-9]{13}$/);
    for (const t of ["manufacturers", "wholesalers", "pharmacies"]) for (const r of d[t]) expect(r.gln).toMatch(/^[0-9]{13}$/);
    const serials = d.packs.map((p: any) => p.serial_no);
    for (const s of serials) expect(s).toMatch(/^[A-Z0-9]{12}$/);
    expect(new Set(serials).size).toBe(serials.length);
    const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 86_400_000;
    const between = (gap: number, max: number) => {
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(max);
    };
    const packs = byId(d.packs);
    for (const p of d.packs) between(days(p.expiry_on, p.commissioned_on), 1095);
    // the chain: each stage follows the one before it, and each link is one-to-one
    const wholesale = byId(d.wholesale_receipts);
    for (const w of d.wholesale_receipts) {
      between(days(w.shipped_on, packs.get(w.pack_id).commissioned_on), 30);
      between(days(w.received_on, w.shipped_on), 7);
    }
    const pharmacy = byId(d.pharmacy_receipts);
    for (const r of d.pharmacy_receipts) {
      between(days(r.shipped_on, wholesale.get(r.wholesale_receipt_id).received_on), 30);
      between(days(r.received_on, r.shipped_on), 5);
    }
    for (const x of d.dispensing) between(days(x.dispensed_on, pharmacy.get(x.pharmacy_receipt_id).received_on), 120);
    const unique = (rows: Record<string, any>[], key: string) => expect(new Set(rows.map((r) => r[key])).size).toBe(rows.length);
    unique(d.wholesale_receipts, "pack_id");
    unique(d.pharmacy_receipts, "wholesale_receipt_id");
    unique(d.dispensing, "pharmacy_receipt_id");
    unique(d.investigations, "pack_id");
    // investigations: dated from the pack, and some still open
    for (const i of d.investigations) {
      between(days(i.opened_on, packs.get(i.pack_id).commissioned_on), 365);
      if (i.closed_on) between(days(i.closed_on, i.opened_on), 60);
    }
    expect(d.investigations.some((i: any) => i.closed_on === null)).toBe(true);
    // a few products dominate (zipf)
    expect(perParent(d.packs, "product_id")).toBeGreaterThan(80 / 5);
  });
});

describe("hr.yaml", () => {
  it("produces data that satisfies every feature it demonstrates", async () => {
    const d = await json("generate", join(examples, "hr.yaml"));
    const employees: Record<string, any>[] = d.employees;
    const ids = new Set(employees.map((e) => e.id));

    // cycle broken through the nullable foreign key, and filled afterwards
    for (const dep of d.departments) expect(ids.has(dep.head_id)).toBe(true);
    // patterns
    for (const dep of d.departments) expect(dep.code).toMatch(/^D[0-9]{3}$/);
    for (const e of employees) expect(e.badge).toMatch(/^EMP-[0-9]{5}$/);
    // self reference points at an earlier employee
    employees.forEach((e, i) => e.manager_id !== null && expect(e.manager_id).toBeLessThanOrEqual(i));
    // cross-column rule
    for (const e of employees) if (e.left_on) expect(e.left_on >= e.hired_on).toBe(true);
    // one-to-one
    const parked = d.parking_spots.map((p: any) => p.employee_id);
    expect(new Set(parked).size).toBe(parked.length);
    // per-parent cap
    const counts = new Map<number, number>();
    for (const q of d.equipment) counts.set(q.employee_id, (counts.get(q.employee_id) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);
  });
});

describe("infer examples", () => {
  it("examples/samples: recovers the relationship and the date rules from the CSVs", async () => {
    const r = await exec("infer", join(examples, "samples"));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/ref: customers\.id/);
    expect(r.out).toMatch(/after: customer_id\.signup_date/);
    expect(r.out).toMatch(/after: placed_at/);
  });

  it("petstore-openapi.yaml: three tables linked by owner_id and pet_id, Visit has 200 rows", async () => {
    const r = await exec("infer", join(examples, "petstore-openapi.yaml"), "--rows", "10");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/ref: Owner\.id/);
    expect(r.out).toMatch(/ref: Pet\.id/);
    expect(r.out).toMatch(/rows: 200/); // x-rows on Visit wins over --rows
  });

  it("make-sample-db.mjs: builds a database that infers into linked tables", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "mockdata-sampledb-")), "sample.db");
    execFileSync(process.execPath, [join(examples, "make-sample-db.mjs"), db]);
    const r = await exec("infer", db);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/order_id:\n\s+type: integer\n\s+ref: orders\.id/);
    expect(r.err).toMatch(/employees\.manager_id: self-referencing foreign key made nullable/);
    expect(r.out).not.toContain("demo@example.com"); // structure only, never rows
  });
});
