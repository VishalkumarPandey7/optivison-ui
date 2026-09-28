import type { RuleDefinition, RuleOperator, SignalDefinition, Zone } from './vision';

export type TemplateCategory = 'Worker' | 'Machine' | 'Counting' | 'Safety' | 'Quality' | 'General';

export interface SignalTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  description: string;
  definition: Omit<SignalDefinition, 'id' | 'zoneId'> & { zoneKind?: Zone['kind'] };
}

export interface RuleTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  description: string;
  output: string;
  combinator: RuleDefinition['combinator'];
  forSeconds: number;
  conditions: Array<{ signalTemplateId: string; operator: RuleOperator; value?: number }>;
}

const signal = (
  id: string,
  name: string,
  category: TemplateCategory,
  description: string,
  definition: SignalTemplate['definition']
): SignalTemplate => ({ id, name, category, description, definition });

export const builtInSignalTemplates: SignalTemplate[] = [
  signal('person-detected', 'Person Detected', 'General', 'Detect a person anywhere in the camera frame.', { name: 'Person Detected', kind: 'object_detected', className: 'person', sourceTask: 'detect', confidence: .35, holdSeconds: .5 }),
  signal('person-in-operator-zone', 'Person In Operator Zone', 'Worker', 'Confirm worker presence inside the selected workstation.', { name: 'Person In Operator Zone', kind: 'object_in_roi', className: 'person', sourceTask: 'detect', confidence: .35, zoneKind: 'operator', holdSeconds: .6 }),
  signal('operator-absent', 'Operator Absent', 'Worker', 'Activate when no person remains in the operator ROI.', { name: 'Operator Absent', kind: 'object_absent_from_roi', className: 'person', sourceTask: 'detect', confidence: .35, zoneKind: 'operator' }),
  signal('body-moving-operator', 'Body Moving In Operator Zone', 'Worker', 'Use YOLO pose movement for active-work evidence.', { name: 'Body Moving In Operator Zone', kind: 'pose_moving', className: 'person', sourceTask: 'pose', confidence: .3, zoneKind: 'operator', motionThreshold: .18, holdSeconds: .8 }),
  signal('workstation-occupancy', 'Workstation Occupancy', 'Worker', 'Count workers currently inside the workstation ROI.', { name: 'Workstation Occupancy', kind: 'object_count', className: 'person', sourceTask: 'detect', confidence: .35, zoneKind: 'operator', countThreshold: 1 }),
  signal('restricted-zone-entry', 'Restricted Zone Entry', 'Safety', 'Record each new person track entering the restricted ROI.', { name: 'Restricted Zone Entry', kind: 'object_entered_roi', className: 'person', sourceTask: 'detect', confidence: .35, zoneKind: 'restricted' }),
  signal('person-restricted-zone', 'Person In Restricted Zone', 'Safety', 'Detect a person currently occupying the restricted ROI.', { name: 'Person In Restricted Zone', kind: 'object_in_roi', className: 'person', sourceTask: 'detect', confidence: .35, zoneKind: 'restricted', holdSeconds: .5 }),
  signal('person-count-now', 'Current Person Count', 'Counting', 'Count people currently visible inside the counting ROI.', { name: 'Current Person Count', kind: 'object_count', className: 'person', sourceTask: 'detect', confidence: .35, zoneKind: 'counting', countThreshold: 1 }),
  signal('conveyor-line-crossing', 'Direct Motion Passes', 'Counting', 'Count stable moving foreground objects once, independent of object class.', { name: 'Direct Motion Passes', kind: 'line_crossing_count', className: 'object', sourceTask: 'detect', confidence: .2, zoneKind: 'counting', lineId: 'conveyor-line' }),
  signal('conveyor-output-rate', 'Conveyor Output Rate', 'Counting', 'Calculate confirmed conveyor passes during the latest minute.', { name: 'Conveyor Output Rate', kind: 'line_crossing_rate', className: 'object', sourceTask: 'detect', confidence: .2, zoneKind: 'counting', lineId: 'conveyor-line' }),
  signal('cell-phone-detected', 'Cell Phone Detected', 'Worker', 'Detect a mobile phone anywhere in the camera frame.', { name: 'Cell Phone Detected', kind: 'object_detected', className: 'cell phone', sourceTask: 'detect', confidence: .25, holdSeconds: .5 }),
  signal('person-near-phone', 'Person Near Mobile Phone', 'Safety', 'Match a person and phone when their tracked centers are close.', { name: 'Person Near Mobile Phone', kind: 'objects_near', className: 'person', secondaryClass: 'cell phone', sourceTask: 'detect', confidence: .25, zoneKind: 'restricted', maxDistancePercent: 18, holdSeconds: .6 }),
  signal('machine-zone-motion', 'Machine Zone Motion', 'Machine', 'Use calibrated pixel movement inside the machine ROI.', { name: 'Machine Zone Motion', kind: 'zone_motion', className: 'machine', sourceTask: 'detect', confidence: .35, zoneKind: 'machine', motionThreshold: 2 }),
  signal('machine-zone-idle', 'Machine Zone Idle', 'Machine', 'Activate when machine-zone movement stays below threshold.', { name: 'Machine Zone Idle', kind: 'zone_idle', className: 'machine', sourceTask: 'detect', confidence: .35, zoneKind: 'machine', motionThreshold: 2 }),
  signal('worker-machine-proximity', 'Worker Near Machine', 'Safety', 'Match a person near a custom machine detection.', { name: 'Worker Near Machine', kind: 'objects_near', className: 'person', secondaryClass: 'machine', sourceTask: 'detect', confidence: .35, zoneKind: 'machine', maxDistancePercent: 22, capabilityNote: 'Requires a custom model exposing a machine class.' }),
  signal('helmet-present-custom', 'Helmet Present', 'Safety', 'Use a customer PPE model to detect helmets in the worker ROI.', { name: 'Helmet Present', kind: 'object_in_roi', className: 'helmet', sourceTask: 'detect', confidence: .35, zoneKind: 'operator', holdSeconds: .5, capabilityNote: 'Requires a custom helmet class.' }),
  signal('helmet-absent-custom', 'Helmet Absent', 'Safety', 'Activate when the customer PPE model finds no helmet.', { name: 'Helmet Absent', kind: 'object_absent_from_roi', className: 'helmet', sourceTask: 'detect', confidence: .35, zoneKind: 'operator', capabilityNote: 'Requires a custom helmet class.' }),
  signal('vest-absent-custom', 'Safety Vest Absent', 'Safety', 'Activate when the worker ROI has no detected safety vest.', { name: 'Safety Vest Absent', kind: 'object_absent_from_roi', className: 'safety vest', sourceTask: 'detect', confidence: .35, zoneKind: 'operator', capabilityNote: 'Requires a custom safety-vest class.' }),
  signal('vehicle-restricted-zone', 'Vehicle In Restricted Zone', 'Safety', 'Detect a COCO car inside the restricted ROI.', { name: 'Vehicle In Restricted Zone', kind: 'object_in_roi', className: 'car', sourceTask: 'detect', confidence: .35, zoneKind: 'restricted', holdSeconds: .5 }),
  signal('defect-detected-custom', 'Defect Detected', 'Quality', 'Use a customer inspection model to detect a defect.', { name: 'Defect Detected', kind: 'object_in_roi', className: 'defect', sourceTask: 'detect', confidence: .35, zoneKind: 'counting', holdSeconds: .5, capabilityNote: 'Requires a custom defect class.' })
];

const rule = (
  id: string,
  name: string,
  category: TemplateCategory,
  description: string,
  output: string,
  forSeconds: number,
  conditions: RuleTemplate['conditions']
): RuleTemplate => ({ id, name, category, description, output, forSeconds, combinator: 'AND', conditions });

export const builtInRuleTemplates: RuleTemplate[] = [
  rule('worker-present', 'Worker Present', 'Worker', 'Operator-zone presence is confirmed.', 'WORKER_PRESENT', 1, [{ signalTemplateId: 'person-in-operator-zone', operator: 'IS_ACTIVE' }]),
  rule('operator-absent-rule', 'Operator Absent', 'Worker', 'No operator remains in the workstation ROI.', 'OPERATOR_ABSENT', 3, [{ signalTemplateId: 'operator-absent', operator: 'IS_ACTIVE' }]),
  rule('worker-working', 'Worker Working', 'Worker', 'A person is present and pose movement shows activity.', 'WORKER_WORKING', 2, [{ signalTemplateId: 'person-in-operator-zone', operator: 'IS_ACTIVE' }, { signalTemplateId: 'body-moving-operator', operator: 'IS_ACTIVE' }]),
  rule('worker-idle', 'Worker Idle', 'Worker', 'A person is present while body movement is inactive.', 'WORKER_IDLE', 60, [{ signalTemplateId: 'person-in-operator-zone', operator: 'IS_ACTIVE' }, { signalTemplateId: 'body-moving-operator', operator: 'IS_NOT_ACTIVE' }]),
  rule('worker-extended-idle', 'Extended Worker Idle', 'Worker', 'A present worker stays inactive for 15 minutes.', 'EXTENDED_WORKER_IDLE', 900, [{ signalTemplateId: 'person-in-operator-zone', operator: 'IS_ACTIVE' }, { signalTemplateId: 'body-moving-operator', operator: 'IS_NOT_ACTIVE' }]),
  rule('worker-extended-absence', 'Extended Workstation Absence', 'Worker', 'The workstation remains empty for 10 minutes.', 'EXTENDED_WORKSTATION_ABSENCE', 600, [{ signalTemplateId: 'operator-absent', operator: 'IS_ACTIVE' }]),
  rule('worker-break-overrun', 'Break Timer Exceeded', 'Worker', 'Absence exceeds a 30-minute break allowance.', 'BREAK_TIMER_EXCEEDED', 1800, [{ signalTemplateId: 'operator-absent', operator: 'IS_ACTIVE' }]),
  rule('workstation-overcrowded', 'Workstation Overcrowded', 'Worker', 'More than one person occupies the workstation.', 'WORKSTATION_OVER_CROWDED', 2, [{ signalTemplateId: 'workstation-occupancy', operator: 'GREATER_THAN', value: 1 }]),
  rule('worker-outside-workstation', 'Worker Outside Workstation', 'Worker', 'A person is visible but outside the operator ROI.', 'WORKER_OUTSIDE_WORKSTATION', 3, [{ signalTemplateId: 'person-detected', operator: 'IS_ACTIVE' }, { signalTemplateId: 'person-in-operator-zone', operator: 'IS_NOT_ACTIVE' }]),
  rule('restricted-intrusion', 'Restricted Zone Intrusion', 'Safety', 'A person occupies the restricted ROI.', 'RESTRICTED_ZONE_INTRUSION', 1, [{ signalTemplateId: 'person-restricted-zone', operator: 'IS_ACTIVE' }]),
  rule('restricted-mobile-use', 'Restricted Mobile Use', 'Safety', 'A phone is tracked close to a person in the restricted ROI.', 'RESTRICTED_MOBILE_USE', 1, [{ signalTemplateId: 'person-near-phone', operator: 'IS_ACTIVE' }]),
  rule('ppe-helmet-violation', 'PPE Helmet Violation', 'Safety', 'A worker is present while the custom helmet signal is absent.', 'PPE_HELMET_VIOLATION', 2, [{ signalTemplateId: 'person-in-operator-zone', operator: 'IS_ACTIVE' }, { signalTemplateId: 'helmet-absent-custom', operator: 'IS_ACTIVE' }]),
  rule('ppe-vest-violation', 'PPE Vest Violation', 'Safety', 'A worker is present while the custom vest signal is absent.', 'PPE_VEST_VIOLATION', 2, [{ signalTemplateId: 'person-in-operator-zone', operator: 'IS_ACTIVE' }, { signalTemplateId: 'vest-absent-custom', operator: 'IS_ACTIVE' }]),
  rule('machine-running', 'Machine Running', 'Machine', 'Machine-zone motion remains above its threshold.', 'MACHINE_RUNNING', 2, [{ signalTemplateId: 'machine-zone-motion', operator: 'IS_ACTIVE' }]),
  rule('machine-idle', 'Machine Idle', 'Machine', 'Machine-zone motion remains below its threshold.', 'MACHINE_IDLE', 5, [{ signalTemplateId: 'machine-zone-idle', operator: 'IS_ACTIVE' }]),
  rule('production-stoppage', 'Production Stoppage', 'Machine', 'Machine-zone idle continues for one minute.', 'PRODUCTION_STOPPAGE', 60, [{ signalTemplateId: 'machine-zone-idle', operator: 'IS_ACTIVE' }]),
  rule('machine-waiting-operator', 'Machine Waiting For Operator', 'Machine', 'Machine is idle while the operator ROI is empty.', 'MACHINE_WAITING_FOR_OPERATOR', 30, [{ signalTemplateId: 'machine-zone-idle', operator: 'IS_ACTIVE' }, { signalTemplateId: 'operator-absent', operator: 'IS_ACTIVE' }]),
  rule('operator-waiting-machine', 'Operator Waiting For Machine', 'Machine', 'Operator is present while the machine remains idle.', 'OPERATOR_WAITING_FOR_MACHINE', 30, [{ signalTemplateId: 'person-in-operator-zone', operator: 'IS_ACTIVE' }, { signalTemplateId: 'machine-zone-idle', operator: 'IS_ACTIVE' }]),
  rule('machine-running-no-operator', 'Machine Running Without Operator', 'Safety', 'Machine movement continues while the operator is absent.', 'MACHINE_RUNNING_OPERATOR_ABSENT', 3, [{ signalTemplateId: 'machine-zone-motion', operator: 'IS_ACTIVE' }, { signalTemplateId: 'operator-absent', operator: 'IS_ACTIVE' }]),
  rule('conveyor-count-target', 'Conveyor Count Target', 'Counting', 'Class-independent conveyor passes reach ten.', 'COUNT_TARGET_REACHED', 0, [{ signalTemplateId: 'conveyor-line-crossing', operator: 'GREATER_THAN', value: 9 }])
];

export function createSignalFromTemplate(template: SignalTemplate, zones: Zone[], id = template.id): SignalDefinition {
  const { zoneKind, ...definition } = template.definition;
  const zoneId = zoneKind ? zones.find((zone) => zone.kind === zoneKind)?.id : undefined;
  return { ...definition, id, zoneId };
}
