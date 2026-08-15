// Comprehensive verification suite for the Twin Text Platform.
// Exercises every critical decision rule, safety gate, and calculation.
import assert from "node:assert";
import { decide, evaluateSafety, classifyReply, detectFailed } from "../server/automation/sop.js";
import { categorizeRow, TAB, rowsForTab, tabCounts, normalizeRow } from "../server/data/store.js";
import { computePercentageReport } from "../server/reports/percentage.js";
import { cleanPersonName, firstNameFrom, renderMessage, getApprovedMessage, pickApprovedTemplate, assertMessageIntegrity, APPROVED_TEMPLATES } from "../server/automation/message.js";
import { SentLedger } from "../server/data/sentLedger.js";
import { AutomationEngine, deriveState } from "../server/automation/engine.js";
import { parseSpreadsheet, exportToXlsx, exportToCsv } from "../server/data/spreadsheet.js";
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("  ❌ FAIL:", name); } };
const eq = (name, a, b) => ok(name + ` (got ${JSON.stringify(a)})`, a === b);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const clean = () => ({ matchFound: true, phoneExists: true, tags: [], historyText: "", companySource: "Twin Home Buyer" });

console.log("A. decide() — the 15 eligibility rules");
eq("clean → Ready To Text", decide(clean()).disposition, "Ready To Text");
eq("clean shouldSend true", decide(clean()).shouldSend, true);
eq("uncertain → Lead NOT Found", decide({ ...clean(), uncertain: true, uncertainReason: "x" }).disposition, "Lead NOT Found");
eq("no match → Lead NOT Found", decide({ matchFound: false }).disposition, "Lead NOT Found");
eq("sold → Property Sold", decide({ ...clean(), propertySold: true }).disposition, "Property Sold");
eq("listed → Listed", decide({ ...clean(), propertyListed: true }).disposition, "Listed");
eq("opt-out tag → Opted Out", decide({ ...clean(), tags: ["Revival - Do Not Text"] }).disposition, "Opted Out");
eq("not interested → Not Interested", decide({ ...clean(), historyText: "not interested" }).disposition, "Not Interested");
eq("STOP → Opted Out", decide({ ...clean(), historyText: "STOP" }).disposition, "Opted Out");
eq("lose my number → Opted Out", decide({ ...clean(), historyText: "please lose my number" }).disposition, "Opted Out");
eq("take me off → Opted Out", decide({ ...clean(), historyText: "take me off your list" }).disposition, "Opted Out");
eq("do not message → Opted Out", decide({ ...clean(), historyText: "do not message me" }).disposition, "Opted Out");
eq("wrong number → Wrong Number", decide({ ...clean(), historyText: "wrong number" }).disposition, "Wrong Number");
eq("active deal recent → Recent Contact", decide({ ...clean(), activeDealTag: true, lastConversationWithinMonth: true }).disposition, "Recent Contact");
eq("active deal COLD → re-engages (Ready)", decide({ ...clean(), activeDealTag: true, lastConversationWithinMonth: false }).disposition, "Ready To Text");
eq("last msg failed → Failed Number", decide({ ...clean(), lastMessageFailed: true }).disposition, "Failed Number");
// Regression (Sarah James): a call-activity note containing "failed"/"ring but
// no answer" must NOT brand a working number as Failed Number.
eq("call note 'failed' → NOT failed marker", detectFailed("Tried calling, ring but no answer. Auto dialer failed. Dropped while ringing."), false);
eq("'call failed' note → NOT failed marker", detectFailed("Outgoing call 34 seconds. Call failed to connect."), false);
// Real SMS delivery failures still detected by the tightened markers.
eq("'message failed' → failed marker", detectFailed("Your message failed to send"), true);
eq("'delivery failed' → failed marker", detectFailed("SMS delivery failed"), true);
eq("'undeliverable' → failed marker", detectFailed("Message undeliverable"), true);
eq("texted this month → Texted This Month", decide({ ...clean(), alreadySentApproved: true, revivalSentThisMonth: true, revivalSentAt: daysAgo(3) }).disposition, "Texted This Month");
eq("texted 10d ago (prior-month flag off) → Texted This Month (30-day)", decide({ ...clean(), alreadySentApproved: true, revivalSentThisMonth: false, revivalSentAt: daysAgo(10) }).disposition, "Texted This Month");
eq("texted 40d ago → Ready To Text (re-engage)", decide({ ...clean(), alreadySentApproved: true, revivalSentThisMonth: false, revivalSentAt: daysAgo(40) }).disposition, "Ready To Text");
eq("already sent, no date → Already Contacted", decide({ ...clean(), alreadySentApproved: true, revivalSentThisMonth: false, revivalSentAt: "" }).disposition, "Already Contacted");
eq("no phone → Lead NOT Found", decide({ ...clean(), phoneExists: false }).disposition, "Lead NOT Found");
eq("company unknown → Needs Review", decide({ ...clean(), companySource: "Random LLC" }).disposition, "Needs Review");
eq("company unknown shouldSend false", decide({ ...clean(), companySource: "Random LLC" }).shouldSend, false);

console.log("B. classifyReply()");
eq("yes call me → interested", classifyReply("Yes, call me").classification, "interested");
eq("not interested → not_interested", classifyReply("not interested").classification, "not_interested");
eq("STOP → not_interested optout", classifyReply("STOP").optOut, true);
eq("please remove → optout", classifyReply("please remove").optOut, true);
eq("who is this → needs_review", classifyReply("who is this?").classification, "needs_review");
eq("mixed → needs_review", classifyReply("make me an offer but i'm not interested right now").classification, "needs_review");
eq("empty → needs_review", classifyReply("").classification, "needs_review");

console.log("C. categorizeRow() → tabs");
const mk = (o) => ({ disposition: o.d || "Pending", activeDeal: !!o.ad, needsManualReview: !!o.nr });
eq("Text Sent", categorizeRow(mk({ d: "Text Sent" })), TAB.TEXT_SENT);
eq("Ready To Text → available", categorizeRow(mk({ d: "Ready To Text" })), TAB.AVAILABLE);
eq("Property Sold", categorizeRow(mk({ d: "Property Sold" })), TAB.PROPERTY_SOLD);
eq("Listed → property-sold", categorizeRow(mk({ d: "Listed" })), TAB.PROPERTY_SOLD);
eq("Opted Out → not-interested", categorizeRow(mk({ d: "Opted Out" })), TAB.NOT_INTERESTED);
eq("Bad Lead", categorizeRow(mk({ d: "Bad Lead" })), TAB.BAD_LEADS);
eq("Out of State", categorizeRow(mk({ d: "Out of State" })), TAB.OUT_OF_STATE);
eq("Recent Contact → active-deal", categorizeRow(mk({ d: "Recent Contact" })), TAB.ACTIVE_DEAL);
eq("activeDeal flag → active-deal (beats Text Sent)", categorizeRow(mk({ d: "Text Sent", ad: true })), TAB.ACTIVE_DEAL);
eq("needsManualReview → needs-review (beats all)", categorizeRow(mk({ d: "Text Sent", nr: true })), TAB.NEEDS_REVIEW);
eq("Error → needs-review", categorizeRow(mk({ d: "Error" })), TAB.NEEDS_REVIEW);
eq("Pending → no tab", categorizeRow(mk({ d: "Pending" })), null);

console.log("D. Percentage math (no NaN/Inf, ≤100%)");
const rep0 = computePercentageReport([]);
ok("empty: no NaN/Infinity", !/NaN|Infinity/.test(JSON.stringify(rep0)));
eq("empty deliveryRate 0", rep0.rates.deliveryRate, 0);
const rows = [
  { disposition: "Text Sent", textSentTimestamp: "t", sentMessageBody: "x", messageDeliveryStatus: "Delivered", replyReceived: true, replyClassification: "interested", activeDeal: true },
  { disposition: "Text Sent", textSentTimestamp: "t", sentMessageBody: "x", messageDeliveryStatus: "Sent", replyReceived: true, replyClassification: "not_interested" },
  { disposition: "Text Sent", textSentTimestamp: "t", sentMessageBody: "x", messageDeliveryStatus: "Sent" },
  { disposition: "Property Sold" }, { disposition: "Out of State" }, { disposition: "Bad Lead" }, { disposition: "Pending" },
];
const rep = computePercentageReport(rows);
eq("totalTextsSent=3", rep.totals.totalTextsSent, 3);
eq("totalReplies=2", rep.totals.totalReplies, 2);
eq("interested=1", rep.totals.interested, 1);
ok("interestedAmongReplies ≤100", rep.replyRates.interestedAmongReplies <= 100);
ok("activeDeal.interestedToActiveDeal ≤100 (clamped)", rep.activeDeal.interestedToActiveDeal <= 100);
ok("no NaN/Infinity", !/NaN|Infinity/.test(JSON.stringify(rep)));

console.log("E. Name cleaning + greeting");
eq("DGDuane Garrido → Duane Garrido", cleanPersonName("DGDuane Garrido"), "Duane Garrido");
eq("MWMICHELLE WINSLOW → MICHELLE WINSLOW", cleanPersonName("MWMICHELLE WINSLOW"), "MICHELLE WINSLOW");
eq("JJohn → John", cleanPersonName("JJohn"), "John");
eq("John Smith unchanged", cleanPersonName("John Smith"), "John Smith");
eq("Unknown → no first name", firstNameFrom("Unknown"), "");
eq("Seller → no first name", firstNameFrom("Seller"), "");
eq("Duane Garrido → Duane", firstNameFrom("Duane Garrido"), "Duane");
ok("render Unknown → 'Hi there'", renderMessage(getApprovedMessage("Twin Home Buyer"), "Unknown").startsWith("Hi there,"));
ok("render Duane → 'Hi Duane'", renderMessage(getApprovedMessage("Twin Home Buyer"), "DGDuane Garrido").startsWith("Hi Duane,"));

console.log("F. Ledger suppression + 30-day");
// Fresh, unique namespace so the test is isolated from any prior run.
const NS = "verifytest" + process.pid;
const L = new SentLedger(NS);
ok("not suppressed initially", !L.isSuppressed({ contactUrl: "/contacts/1" }));
L.suppress({ contactUrl: "/contacts/1", phone: "5551112222", classification: "interested" });
ok("suppressed after suppress()", !!L.isSuppressed({ contactUrl: "/contacts/1" }));
ok("suppressed by phone too", !!L.isSuppressed({ phone: "(555) 111-2222" }));
ok("persists new instance", !!new SentLedger(NS).isSuppressed({ contactUrl: "/contacts/1" }));
L.record({ contactUrl: "/contacts/2", phone: "5559998888", iso: daysAgo(10) });
ok("textedWithinDays 30 hit", !!L.textedWithinDays({ contactUrl: "/contacts/2" }, 30));
ok("textedWithinDays 5 miss", !L.textedWithinDays({ contactUrl: "/contacts/2" }, 5));

console.log("G. Engine defaults + dedup keys");
const e = new AutomationEngine();
eq("useLedgerMemory default false", e.useLedgerMemory, false);
eq("scanOnly default false", e._scanOnly, false);
eq("autoRecheckAfterRun default true", e.autoRecheckAfterRun, true);
eq("dailySendHardCap 300", e.dailySendHardCap, 300);
eq("recentTextDays 30", e.recentTextDays, 30);
eq("allowUnknownStateText false", e.allowUnknownStateText, false);
ok("CA allowed", e.allowedStates.has("CA"));
const k = e._runDedupKeys("https://my.reiblackbook.com/contacts/9", "(510) 916-3995");
ok("dedup keys c+p", k.includes("c:9") && k.includes("p:5109163995"));
// deriveState — read the state out of a messy address so a clearly-CA lead is
// not wrongly held as "state unknown" (real case: 1607 Santa Clara St, Vallejo).
eq("split state,zip + empty field → CA", deriveState({ propertyAddress: "1607 Santa Clara St, , Vallejo, CA, 94590" }), "CA");
eq("state+zip together → CA", deriveState({ propertyAddress: "123 Main St, Vallejo CA 94590" }), "CA");
eq("state in its own field → TX", deriveState({ propertyAddress: "9 Oak Ave", city: "Austin", state: "TX", zip: "78701" }), "TX");
eq("no state anywhere → ''", deriveState({ propertyAddress: "9 Oak Ave", city: "Austin" }), "");
eq("zip with no state → ''", deriveState({ propertyAddress: "9 Oak Ave, Austin, 78701" }), "");

// Auto-correct stale "Unknown" delivery when the text was confirmed sent.
eq("confirmed-sent + Unknown → Sent", normalizeRow({ sentMessageBody: "Hi", textSentTimestamp: "2026-08-11T00:00:00Z", messageDeliveryStatus: "Unknown" }).messageDeliveryStatus, "Sent");
eq("confirmed-sent + blank → Sent", normalizeRow({ sentMessageBody: "Hi", textSentTimestamp: "2026-08-11T00:00:00Z", messageDeliveryStatus: "" }).messageDeliveryStatus, "Sent");
eq("real Failed stays Failed", normalizeRow({ sentMessageBody: "Hi", textSentTimestamp: "2026-08-11T00:00:00Z", messageDeliveryStatus: "Failed" }).messageDeliveryStatus, "Failed");
eq("not-sent + Unknown stays Unknown", normalizeRow({ sentMessageBody: "", textSentTimestamp: "", messageDeliveryStatus: "Unknown" }).messageDeliveryStatus, "Unknown");

console.log("H. Message integrity + rotation");
assertMessageIntegrity(); pass++;
eq("THB 5 templates", APPROVED_TEMPLATES["Twin Home Buyer"].length, 5);
ok("pickApprovedTemplate returns a THB template", APPROVED_TEMPLATES["Twin Home Buyer"].includes(pickApprovedTemplate("Twin Home Buyer")));
eq("unknown company → null", pickApprovedTemplate("Nope"), null);

console.log("I. Spreadsheet round-trip");
const parsed = parseSpreadsheet(fs.readFileSync("data/sample-leads.csv"));
ok("parsed rows > 0", parsed.rows.length > 0);
const job = { originalHeaders: parsed.originalHeaders, dispositionHeader: "Disposition", notesHeader: "Notes", rows: parsed.rows.map((r) => ({ ...r, disposition: "Text Sent", sentMessageBody: "hi", messageDeliveryStatus: "Sent" })) };
const csv = exportToCsv(job);
ok("csv has Message Sent col", csv.includes("Message Sent"));
ok("xlsx builds", exportToXlsx(job).length > 1000);
// Lossless round-trip: export a texted+replied lead, re-import, and confirm the
// delivery/reply results (not just the disposition) survive so the Percentage
// Report rebuilds after a re-upload on another PC.
const rtJob = { originalHeaders: ["Owner Name","Phone","Disposition","Notes"], dispositionHeader: "Disposition", notesHeader: "Notes",
  rows: [{ rowNumber:1, original:{"Owner Name":"Jane","Phone":"5105551234","Disposition":"","Notes":""}, ownerName:"Jane", phone:"5105551234", state:"CA",
    disposition:"Text Sent", notes:"sent", reiContactUrl:"https://my.reiblackbook.com/contacts/55",
    textSentTimestamp:"2026-08-11T17:00:00Z", sentMessageBody:"Hi Jane...", messageDeliveryStatus:"Delivered",
    replyReceived:true, replyText:"Yes interested", replyClassification:"interested", recheckCompleted:true }] };
const rt = parseSpreadsheet(exportToXlsx(rtJob)).rows[0];
eq("round-trip disposition", rt.disposition, "Text Sent");
eq("round-trip delivery survives", rt.messageDeliveryStatus, "Delivered");
ok("round-trip reply survives", rt.replyReceived === true && rt.replyClassification === "interested");
const rtRep = computePercentageReport([rt]);
eq("round-trip reply rate 100%", rtRep.rates.overallReplyRate, 100);
eq("round-trip interested-among-replies 100%", rtRep.replyRates.interestedAmongReplies, 100);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
