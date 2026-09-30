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
