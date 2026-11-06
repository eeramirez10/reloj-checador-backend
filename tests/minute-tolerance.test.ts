import { describe,expect,it } from 'vitest';
import { dateAtLocalTime } from '../src/domain/entities/local-date.js';
import { evaluateDay } from '../src/domain/entities/schedule-evaluator.js';
import { applyLeaveAuthorizations } from '../src/domain/entities/leave-attendance.js';
import { evaluateSubjectAttendance } from '../src/domain/use-cases/evaluate-subject-attendance.js';
import { DEFAULT_OVERTIME_SETTINGS } from '../src/domain/entities/overtime.js';
import type { PolicySettings,ScheduleSettings } from '../src/domain/entities/organization.js';
import type { EvaluationSnapshot,SubjectLog } from '../src/domain/repositories/evaluation-repository.js';

const date='2026-10-26';
const schedule:ScheduleSettings={workDays:[1,2,3,4,5],entryTime:'08:30',exitTime:'18:00',mealEnabled:true,
  mealStart:'15:00',mealEnd:'15:00',mealDurationMinutes:60,mealDetection:'configured',recognitionMarginMinutes:30};
const policy:PolicySettings={entryToleranceMinutes:15,mealToleranceMinutes:15,entryAllowedTardies:3,mealAllowedTardies:3,accumulationMode:'calendar_month',accumulationDays:30};
function at(time:string,zone='America/Mexico_City') {
  const [hour,minute,second='0']=time.split(':');
  return new Date(dateAtLocalTime(date,`${hour}:${minute}`,zone).getTime()+Number(second)*1000);
}
function logs(times:string[],zone='America/Mexico_City') {return times.map((time,index)=>({id:`scan-${index}`,occurredAt:at(time,zone)}));}
const closed=new Date('2026-10-27T12:00:00Z');

describe('inclusive minute-level tolerances',()=>{
  it.each(['America/Mexico_City','America/Cancun'])('permits the complete entry limit minute in %s and starts tardiness at the following minute',zone=>{
    for(const mealDetection of ['configured','automatic','disabled'] as const) {
      const settings={...schedule,mealDetection,mealEnabled:mealDetection==='configured'};
      for(const time of ['08:45:00','08:45:30','08:45:59.999']) {
        const day=evaluateDay(date,logs([time,'15:00','16:00','18:00'],zone),settings,policy,zone,closed);
        expect(day.incidents.filter(item=>item.kind==='arrival')).toEqual([]);
        expect(day.entry).toBe(at(time,zone).toISOString());
      }
      for(const time of ['08:46:00','08:46:59.999']) {
        const day=evaluateDay(date,logs([time,'15:00','16:00','18:00'],zone),settings,policy,zone,closed);
        expect(day.incidents.find(item=>item.kind==='arrival')?.minutes).toBe(16);
      }
    }
  });

  it.each(['15:15:00','15:15:59.999','15:16:00'])('applies the same clock-minute boundary to meal departure %s',departure=>{
    const departed=at(departure);const returned=new Date(departed.getTime()+60*60000);
    const punches=[{id:'entry',occurredAt:at('08:30')},{id:'departure',occurredAt:departed},{id:'return',occurredAt:returned},{id:'exit',occurredAt:at('18:00')}];
    const day=evaluateDay(date,punches,schedule,policy,'America/Mexico_City',closed);
    expect(day.status).toBe('complete');
    expect(day.incidents.filter(item=>item.kind==='meal_departure').map(item=>item.minutes)).toEqual(departure.startsWith('15:16')?[16]:[]);
    expect(day.incidents.filter(item=>item.kind==='meal_return')).toEqual([]);
    expect(day.expectedMealReturn).toBe(returned.toISOString());
  });

  it('ignores seconds of the expected meal-return time only when comparing tolerances, while preserving all observed times',()=>{
    for(const time of ['16:15:00','16:15:59.999','16:16:00','16:16:59.999']) {
      const punches=logs(['08:30','15:00:37',time,'18:00']);
      const day=evaluateDay(date,punches,schedule,policy,'America/Mexico_City',closed);
      expect(day.expectedMealReturn).toBe(at('16:00:37').toISOString());
      expect(day.mealDeparture).toBe(at('15:00:37').toISOString());expect(day.mealReturn).toBe(at(time).toISOString());
      expect(day.incidents.filter(item=>item.kind==='meal_return').map(item=>item.minutes)).toEqual(time.startsWith('16:16')?[16]:[]);
      expect(day.punches.map(item=>item.occurredAt)).toEqual(punches.map(item=>item.occurredAt.toISOString()));
    }
  });

  it('includes the scheduled minute with zero tolerance and treats the next clock minute as late even when fewer than sixty seconds elapsed',()=>{
    const zero={...policy,entryToleranceMinutes:0,mealToleranceMinutes:0};
    const permitted=evaluateDay(date,logs(['08:30:59.999','15:00:37','16:00:59.999','18:00']),schedule,zero,'America/Mexico_City',closed);
    expect(permitted.incidents).toEqual([]);
    const late=evaluateDay(date,logs(['08:31:00','15:00:37','16:01:00','18:00']),schedule,zero,'America/Mexico_City',closed);
    expect(late.incidents.map(item=>[item.kind,item.minutes])).toEqual([['arrival',1],['meal_return',1]]);
  });

  it('waits until the next minute before marking a missing meal return overdue and never creates a tardy without a punch',()=>{
    const punches=logs(['08:30','15:00:37']);
    const within=evaluateDay(date,punches,schedule,policy,'America/Mexico_City',at('16:15:59.999'));
    const overdue=evaluateDay(date,punches,schedule,policy,'America/Mexico_City',at('16:16:00'));
    expect(within.missingMovements).not.toContain('meal_return');expect(overdue.missingMovements).toContain('meal_return');
    expect(overdue.incidents).toEqual([]);expect(overdue.workedMinutes).toBeUndefined();
  });

  it('applies the full limit minute after a late-arrival authorization and keeps earlier unauthorized gaps uncovered',()=>{
    const arrival={requestId:'leave',kind:'late_arrival' as const,paid:true,useVacation:false,reason:'Cita',authorizedTime:'10:00',start:at('08:30').toISOString(),end:at('10:00').toISOString()};
    for(const time of ['10:15:59.999','10:16:00']) {
      const day=evaluateDay(date,logs([time,'15:00','16:00','18:00']),schedule,policy,'America/Mexico_City',closed);
      applyLeaveAuthorizations(day,[arrival],schedule,policy,'America/Mexico_City');
      expect(day.incidents.filter(item=>item.kind==='arrival').map(item=>item.minutes)).toEqual(time.startsWith('10:16')?[16]:[]);
    }
    const changed={...schedule,entryTime:'07:30'};
    const day=evaluateDay(date,logs(['10:00:59','15:00','16:00','18:00']),changed,policy,'America/Mexico_City',closed);
    applyLeaveAuthorizations(day,[arrival],changed,policy,'America/Mexico_City');
    expect(day.incidents.find(item=>item.kind==='arrival')?.minutes).toBe(60);
  });

  it('uses the same boundary for route entries and keeps real route endpoints and extra seconds',()=>{
    const snapshot:EvaluationSnapshot={branches:[{id:'branch',name:'Branch',timeZone:'America/Mexico_City'}],
      policies:[{id:'policy',branchId:'branch',effectiveFrom:'2026-01-01',settings:policy,createdAt:closed}],
      schedules:[{id:'schedule',branchId:'branch',name:'Base',isDefault:true,effectiveFrom:'2026-01-01',settings:schedule,createdAt:closed}],
      assignments:[],branchAssignments:[],logs:[],employeeSchedules:[{id:'version',employeeId:'person',effectiveFrom:'2026-01-01',createdAt:closed,source:'manual',
        workHours:null,meal:null,recognitionMarginMinutes:30,overtime:{...DEFAULT_OVERTIME_SETTINGS,enabled:true,workMode:'route'}}]};
    for(const time of ['08:45:59.999','08:46:00']) {
      const punches:SubjectLog[]=logs([time,'18:30:15']).map(log=>({...log,employeeId:'person',deviceUserId:'clock-user',subjectId:'person',name:'Persona',employeeNumber:null,userId:'42',branchId:'branch'}));
      const [day]=evaluateSubjectAttendance(punches,snapshot,closed);
      expect(day.daily.incidents.map(item=>item.minutes)).toEqual(time.startsWith('08:46')?[16]:[]);
      expect(day.daily.routes?.[0].enteredAt).toBe(at(time).toISOString());expect(day.daily.overtime?.netSeconds).toBe(1815);
    }
  });
});
