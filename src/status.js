"use strict";

function renderStatusLine(status) {
  if (String(status.process.summary || "").trim()) {
    return String(status.process.summary).trim();
  }
  const total = Math.max(status.process.total || 0, status.todos.length);
  const completed = status.process.completed || 0;
  const failed = status.process.failed || 0;
  const subtaskTotal = Math.max(
    status.process.subtask_total || 0,
    status.todos.reduce((sum, task) => sum + (task.subtasks ? task.subtasks.length : 0), 0),
  );
  const subtaskCompleted = Math.max(
    status.process.subtask_completed || 0,
    status.todos
      .flatMap((task) => task.subtasks || [])
      .filter((subtask) => String(subtask.status || "").trim() === "completed")
      .length,
  );
  if (failed > 0) {
    if (subtaskTotal > 0) {
      return `${total} todo(s), ${completed} completed, ${subtaskCompleted}/${subtaskTotal} subtasks completed, ${failed} failed`;
    }
    return `${total} todo(s), ${completed} completed, ${failed} failed`;
  }
  if (subtaskTotal > 0) {
    return `${total} todo(s), ${completed} completed, ${subtaskCompleted}/${subtaskTotal} subtasks completed`;
  }
  return `${total} todo(s), ${completed} completed`;
}

module.exports = { renderStatusLine };
