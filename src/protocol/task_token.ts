// The lease/identity handed to a worker along with a polled task. Opaque to
// workers — they poll a task, do the work, and hand the same token back on
// complete. In-memory today it is a plain string; Phase-5 leasing gives it a
// timeout so a crashed worker's task can be redelivered to another.
export type TaskToken = string;
