import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import specSchema from "../../runtime/schemas/delegation-spec.v1.json" with { type: "json" };
import autopilotSpecSchema from "../../runtime/schemas/autopilot-spec.v2.json" with { type: "json" };
import candidateDecisionSchema from "../../runtime/schemas/candidate-decision.v2.json" with { type: "json" };
import resultSchema from "../../runtime/schemas/attempt-result.v1.json" with { type: "json" };
import reviewSchema from "../../runtime/schemas/review-report.v1.json" with { type: "json" };
import fixSchema from "../../runtime/schemas/fix-report.v1.json" with { type: "json" };
import incrementSchema from "../../runtime/schemas/increment-report.v1.json" with { type: "json" };
import verificationSchema from "../../runtime/schemas/verification-report.v1.json" with { type: "json" };
import advisorSchema from "../../runtime/schemas/advisor-report.v1.json" with { type: "json" };
import autopilotEligibilitySchema from "../../runtime/schemas/autopilot-eligibility.v1.json" with { type: "json" };
import autopilotWorkflowStateSchema from "../../runtime/schemas/autopilot-workflow-state.v2.json" with { type: "json" };
import runStatusSchema from "../../runtime/schemas/run-status.v1.json" with { type: "json" };
import pipelineGateClearedSchema from "../../runtime/schemas/pipeline-gate-cleared.v1.json" with { type: "json" };

import { PROTOCOL_VERSION } from "./versions.js";

export const DELEGATION_SPEC_SCHEMA_KEY = "delegation-spec.v1.json";
const ISO_DATE_TIME = /^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/u;

function isIsoDateTime(value: string): boolean {
  const match = ISO_DATE_TIME.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

export interface CompiledSchemas {
  delegationSpec: ValidateFunction;
  autopilotSpec: ValidateFunction;
  candidateDecision: ValidateFunction;
  attemptResult: ValidateFunction;
  reviewReport: ValidateFunction;
  fixReport: ValidateFunction;
  incrementReport: ValidateFunction;
  verificationReport: ValidateFunction;
  advisorReport: ValidateFunction;
  autopilotEligibility: ValidateFunction;
  autopilotWorkflowState: ValidateFunction;
  runStatus: ValidateFunction;
  pipelineGateCleared: ValidateFunction;
}

export function loadSchemas(): CompiledSchemas {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("date-time", {
    type: "string",
    validate: isIsoDateTime,
  });
  ajv.addSchema(specSchema as object, DELEGATION_SPEC_SCHEMA_KEY);
  const delegationSpec = ajv.getSchema(DELEGATION_SPEC_SCHEMA_KEY);
  if (delegationSpec === undefined) {
    throw new Error("failed to register the canonical Delegation Spec schema");
  }
  return {
    delegationSpec,
    autopilotSpec: ajv.compile(autopilotSpecSchema as object),
    candidateDecision: ajv.compile(candidateDecisionSchema as object),
    attemptResult: ajv.compile(resultSchema as object),
    reviewReport: ajv.compile(reviewSchema as object),
    fixReport: ajv.compile(fixSchema as object),
    incrementReport: ajv.compile(incrementSchema as object),
    verificationReport: ajv.compile(verificationSchema as object),
    advisorReport: ajv.compile(advisorSchema as object),
    autopilotEligibility: ajv.compile(autopilotEligibilitySchema as object),
    autopilotWorkflowState: ajv.compile(autopilotWorkflowStateSchema as object),
    runStatus: ajv.compile(runStatusSchema as object),
    pipelineGateCleared: ajv.compile(pipelineGateClearedSchema as object),
  };
}

export function checkVersionCompat(
  skillProtocolVersion: string,
): { ok: boolean; diagnostic?: string } {
  if (skillProtocolVersion === PROTOCOL_VERSION) {
    return { ok: true };
  }

  return {
    ok: false,
    diagnostic:
      "protocol version mismatch: skill declares " +
      skillProtocolVersion +
      ", runtime expects " +
      PROTOCOL_VERSION,
  };
}
