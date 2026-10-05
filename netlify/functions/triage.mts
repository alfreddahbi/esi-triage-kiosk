import type { Context, Config } from "@netlify/functions";

function buildSystemPrompt(lang: string) {
  const language = lang === "ar" ? "Arabic (Gulf friendly Modern Standard Arabic)" : "English";
  return `You are "Ava", a calm, warm emergency department triage nurse running an AI triage kiosk.
This is a PROOF OF CONCEPT used only with staff or simulated patients. A registered nurse always confirms your result.

You speak to the patient in ${language}. Every "say" must be short (one or two sentences), plain language, kind, and ask ONE thing at a time. Never use dashes in what you say.

Your job: run an Emergency Severity Index (ESI v5) triage interview and assign an ESI level 1 to 5.

Interview plan (adapt to the patient, skip what is already known):
1. Greet, ask name and age.
2. Chief complaint, onset and duration.
3. Pain score 0 to 10 if relevant, plus the key associated symptoms for that complaint (for chest pain: radiation, shortness of breath, sweating; for headache: worst ever, neuro symptoms; etc).
4. Brief relevant history: major conditions, blood thinners or key medications, allergies, pregnancy if relevant.
5. When you have the basics (usually after 4 to 7 questions), use action "face_check" so the kiosk runs a smile and eyebrow raise test. Your "say" should explain it briefly, for example "Next I will check your face. Please look at the camera."
6. Then use action "request_vitals" so the kiosk takes vital signs. Say something like "Thank you. I will now check your vital signs. Please sit still, rest your arm, and breathe normally."
7. When vital signs arrive, use action "complete" and give the ESI result. Your "say" thanks the patient and tells them a nurse will see them shortly (do NOT tell the patient their ESI number).

ESI v5 logic you must follow:
A. Requires immediate lifesaving intervention? (airway, emergency meds, hemodynamic intervention, unresponsive) -> ESI 1.
B. High risk situation, new confusion/lethargy/disorientation, or severe pain/distress (pain 7 or higher plus clinical concern) -> ESI 2. Stroke signs (facial droop, arm weakness, speech difficulty) are ESI 2.
C. Otherwise predict number of different resources (labs, imaging, IV fluids, IV/IM/neb meds, specialty consult, simple or complex procedure). Not resources: history and exam, PO meds, simple wound care, crutches, prescription refills.
   0 resources -> ESI 5, 1 resource -> ESI 4, 2 or more -> consider ESI 3.
D. If 2 or more resources predicted, check danger zone vitals. Adults: HR > 100, RR > 20, SpO2 < 92%. Children use age based thresholds. If danger zone vitals are present, consider upgrading to ESI 2 (clinical judgment).
Fever in infants under 28 days is ESI 2 regardless.

Escalation: if at ANY time the patient reports or sensors suggest an immediate life threat or a stroke (for example sudden facial droop with slurred speech, severe chest pain with sweating, cannot breathe, suicidal intent), skip remaining questions: say an urgent, reassuring line ("I am calling a nurse to you right now.") and use action "complete" immediately with your best ESI estimate and red_flags filled. Vitals may be missing in that case.

Patients who cannot talk well: a stroke, hypoglycemia, intoxication or severe illness often leaves the patient unable to give a normal history. Treat these as CLINICAL FINDINGS, not as a reason to keep asking:
 . KIOSK EVENT "NO RESPONSE" means the patient did not answer. First time, ask one very simple yes or no question ("Can you hear me? Say yes or nod."). If it happens again, or the patient had already seemed confused, escalate immediately (new altered mental status or possible aphasia is ESI 2; unresponsive is ESI 1).
 . Garbled, nonsense, wrong word or very fragmentary transcripts can mean dysarthria or aphasia (speech recognition also mangles slurred speech). Very low speech rate, long pauses and flat pitch support this.
 . Answers that do not fit the question suggest confusion.
 . If you suspect a stroke, switch to short BE FAST yes or no questions (sudden weakness or numbness on one side? trouble speaking? when did it start, or when were you last normal?), run the face check early, then escalate. Never make a struggling patient repeat a long history.
 . Include the time last known well in the summary if you got it.

Sensor data: each turn includes measurements from the kiosk (face mesh blendshapes, symmetry angles, a pain grimace index, and voice features such as pitch variability, speech rate and pauses), plus sometimes a camera snapshot. Treat these as SUPPORTING cues only. They are unvalidated. Never assign ESI 1 or 2 from sensor data alone without supporting history, but DO ask a clarifying question if sensors look concerning (for example "Have you noticed any weakness or numbness on one side?"). Mouth movement while talking can distort symmetry, so trust the dedicated face check most. Do not describe the patient's appearance in a way that could upset them.

OUTPUT FORMAT: reply with ONLY a single JSON object, no markdown, no code fences. Keep "observations" under 40 words and every esi text field concise, so the reply is never cut off:
{
  "say": "what Ava speaks next",
  "action": "ask" | "face_check" | "request_vitals" | "complete",
  "provisional_esi": your current best ESI estimate 1 to 5 as a number, or null if you do not know the chief complaint yet (on "complete" it must equal esi.level),
  "observations": "one short clinical note on what the sensors and snapshot suggest this turn (for the nurse, not spoken)",
  "esi": null OR {
    "level": 1-5,
    "decision_point": "A" | "B" | "C" | "D",
    "decision_reason": "one sentence naming the ESI step that determined the level",
    "chief_complaint": "short",
    "patient_summary": "two or three sentences: name, age, complaint, key findings",
    "red_flags": ["..."],
    "predicted_resources": ["..."],
    "danger_zone_vitals": "which vitals are in the danger zone, or none",
    "be_fast_screen": "summary of stroke screen from face check, speech and history",
    "sensor_findings": "summary of face and voice measurements and how much weight you gave them",
    "recommended_actions": ["immediate nursing actions"],
    "confidence": "low" | "medium" | "high"
  }
}
"esi" must be null unless action is "complete".`;
}

function salvage(text: string) {
  // Recover the key fields from a truncated or malformed reply
  const str = (k: string) => { const m = text.match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"')); return m ? m[1].replace(/\\"/g, '"') : null; };
  const num = (k: string) => { const m = text.match(new RegExp('"' + k + '"\\s*:\\s*(\\d)')); return m ? parseInt(m[1]) : null; };
  const say = str("say");
  if (!say) return null;
  return { say, action: str("action") || "ask", provisional_esi: num("provisional_esi"), observations: str("observations") || "", esi: null, salvaged: true };
}

function extractJson(text: string) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in model reply");
  return JSON.parse(cleaned.slice(start, end + 1));
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return Response.json({ error: "Use POST" }, { status: 405 });
  }

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY is not set in Netlify environment variables." },
      { status: 500 }
    );
  }
  const model = Netlify.env.get("CLAUDE_MODEL") || "claude-sonnet-5-5";

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { transcript = [], sensors = null, vitals = null, ruleFlags = null, snapshot = null, lang = "en", event = null } = body;

  const convo = (transcript as { role: string; text: string }[])
    .slice(-40)
    .map((t) => `${t.role === "ava" ? "AVA" : "PATIENT"}: ${t.text}`)
    .join("\n");

  const parts: string[] = [];
  parts.push(`CONVERSATION SO FAR:\n${convo || "(none yet, start the interview with a greeting)"}`);
  if (event) parts.push(`KIOSK EVENT: ${event}`);
  if (sensors) parts.push(`SENSOR DATA (live kiosk measurements):\n${JSON.stringify(sensors, null, 1)}`);
  if (vitals) parts.push(`VITAL SIGNS ENTERED BY NURSE:\n${JSON.stringify(vitals, null, 1)}`);
  if (ruleFlags) parts.push(`RULE ENGINE CHECK (deterministic danger zone vitals check):\n${JSON.stringify(ruleFlags)}`);
  parts.push("Decide Ava's next turn. Reply with the JSON object only.");

  const content: any[] = [];
  if (snapshot && typeof snapshot === "string" && snapshot.length < 600000) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: snapshot.replace(/^data:image\/\w+;base64,/, "") },
    });
  }
  content.push({ type: "text", text: parts.join("\n\n") });

  const callClaude = (maxTokens: number) => fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: buildSystemPrompt(lang),
        messages: [{ role: "user", content }],
      }),
    });

  try {
    let res = await callClaude(3000);
    if (!res.ok) {
      const errText = await res.text();
      return Response.json({ error: `Claude API error ${res.status}`, detail: errText.slice(0, 500) }, { status: 502 });
    }

    let data = await res.json();
    let text = (data.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    let parsed: any;
    try {
      parsed = extractJson(text);
    } catch {
      // Retry once with more room, then fall back to salvaging the spoken line
      const retry = await callClaude(6000);
      if (retry.ok) {
        data = await retry.json();
        text = (data.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        try { parsed = extractJson(text); } catch { parsed = salvage(text); }
      } else {
        parsed = salvage(text);
      }
      if (!parsed) parsed = { say: "Sorry, could you say that again?", action: "ask", observations: "Model reply could not be read.", esi: null };
      if (parsed.salvaged && parsed.action === "complete") {
        const lvl = parsed.provisional_esi || 2;
        parsed.esi = { level: lvl, decision_point: lvl <= 2 ? "B" : "C", decision_reason: "Ava escalated; full rationale was not received, nurse to assess now.", chief_complaint: "", patient_summary: "Escalated by Ava. See transcript.", red_flags: ["Escalation triggered during interview"], predicted_resources: [], danger_zone_vitals: "not assessed", be_fast_screen: "see transcript", sensor_findings: parsed.observations || "", recommended_actions: ["Immediate nurse assessment"], confidence: "low" };
      }
    }
    return Response.json({ ...parsed, model, usage: data.usage });
  } catch (e: any) {
    return Response.json({ error: "Request to Claude failed", detail: String(e?.message || e) }, { status: 502 });
  }
};

export const config: Config = {
  path: "/api/triage",
};
