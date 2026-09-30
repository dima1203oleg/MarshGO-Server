export type TransferRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface TransferEvaluationInput {
  predictedArrivalAt: Date;
  etaUncertaintySeconds: number;
  nextDepartureAt: Date;
  walkingSeconds: number;
  minimumTransferBufferSeconds: number;
  boardingGraceSeconds?: number;
}

export interface TransferEvaluation {
  feasible: boolean;
  risk: TransferRisk;
  availableSeconds: number;
  requiredSeconds: number;
  slackSeconds: number;
  connectionWindowStart: Date;
  connectionWindowEnd: Date;
}

export function evaluateTransfer(input: TransferEvaluationInput): TransferEvaluation {
  const values = [input.predictedArrivalAt.getTime(), input.nextDepartureAt.getTime()];
  if (values.some((value) => !Number.isFinite(value))
    || !Number.isInteger(input.etaUncertaintySeconds) || input.etaUncertaintySeconds < 0
    || !Number.isInteger(input.walkingSeconds) || input.walkingSeconds < 0
    || !Number.isInteger(input.minimumTransferBufferSeconds) || input.minimumTransferBufferSeconds < 0
    || !Number.isInteger(input.boardingGraceSeconds ?? 0) || (input.boardingGraceSeconds ?? 0) < 0) {
    throw new TypeError('transfer timing inputs must be valid non-negative seconds and dates');
  }

  const arrival = input.predictedArrivalAt.getTime();
  const departure = input.nextDepartureAt.getTime();
  const availableSeconds = Math.floor((departure - arrival) / 1000);
  const requiredSeconds = input.etaUncertaintySeconds + input.walkingSeconds
    + input.minimumTransferBufferSeconds + (input.boardingGraceSeconds ?? 0);
  const slackSeconds = availableSeconds - requiredSeconds;
  const risk: TransferRisk = slackSeconds < 0 ? 'CRITICAL'
    : slackSeconds < 300 ? 'HIGH'
      : slackSeconds < 900 ? 'MEDIUM' : 'LOW';
  const connectionWindowStart = new Date(arrival - input.etaUncertaintySeconds * 1000);
  const connectionWindowEnd = new Date(arrival + (input.etaUncertaintySeconds + input.walkingSeconds + (input.boardingGraceSeconds ?? 0)) * 1000);

  return {
    feasible: slackSeconds >= 0,
    risk,
    availableSeconds,
    requiredSeconds,
    slackSeconds,
    connectionWindowStart,
    connectionWindowEnd,
  };
}
