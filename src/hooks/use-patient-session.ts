import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type PatientAppointment = Tables<"appointments"> & { doctor: Pick<Tables<"doctors">, "full_name" | "specialization"> | null };

export type PatientRecordState =
  | { status: "signed-out" }
  | { status: "loading" }
  | { status: "unlinked" }
  | { status: "blocked"; message: string }
  | {
      status: "linked";
      patient: Tables<"patients">;
      appointments: PatientAppointment[];
      clinic: Pick<Tables<"clinics">, "id" | "name" | "address" | "phone" | "opening_hours"> | null;
      notifications: Tables<"notifications">[];
      passes: Pick<Tables<"appointment_passes">, "id" | "appointment_id" | "reference_code" | "expires_at">[];
      screenings: Pick<Tables<"triage_records">, "id" | "created_at" | "review_status">[];
      partialError: boolean;
    };

export async function requestPatientAccountLink() {
  return supabase.rpc("link_patient_account");
}

/** Reads only rows the clinic's security rules allow for the signed-in patient (patients.auth_user_id = auth user). */
export function usePatientSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [record, setRecord] = useState<PatientRecordState>({ status: "signed-out" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    void supabase.auth.getSession().then(({ data: d }) => setSession(d.session));
    return () => data.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;
  useEffect(() => {
    if (!userId) {
      setRecord({ status: "signed-out" });
      return;
    }
    let cancelled = false;
    setRecord({ status: "loading" });
    void (async () => {
      const { data: patient, error } = await supabase.from("patients").select("*").eq("auth_user_id", userId).maybeSingle();
      if (cancelled) return;
      if (error) return setRecord({ status: "blocked", message: error.code === "42501" ? "The clinic hasn't granted signed-in patients access to their records yet." : "Your clinic record couldn't be loaded right now." });
      if (!patient) return setRecord({ status: "unlinked" });
      const [appts, clinic, notes, passes, screenings] = await Promise.all([
        supabase.from("appointments").select("*, doctor:doctors(full_name, specialization)").eq("patient_id", patient.id).order("appointment_date", { ascending: false }),
        supabase.from("clinics").select("id, name, address, phone, opening_hours").eq("id", patient.clinic_id).maybeSingle(),
        supabase.from("notifications").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(50),
        supabase.from("appointment_passes").select("id, appointment_id, reference_code, expires_at").eq("patient_id", patient.id),
        supabase.from("triage_records").select("id, created_at, review_status").eq("patient_id", patient.id).order("created_at", { ascending: false }),
      ]);
      if (cancelled) return;
      setRecord({
        status: "linked",
        patient,
        appointments: appts.error ? [] : ((appts.data ?? []) as PatientAppointment[]),
        clinic: clinic.data ?? null,
        notifications: notes.data ?? [],
        passes: passes.data ?? [],
        screenings: screenings.data ?? [],
        partialError: Boolean(appts.error || clinic.error || notes.error || passes.error || screenings.error),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, reloadKey]);

  const refreshRecord = () => setReloadKey((key) => key + 1);

  return { session, record, refreshRecord };
}
