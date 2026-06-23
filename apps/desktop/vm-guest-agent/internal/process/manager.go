// Package process manages child process lifecycle (spawn, kill, PID tracking).
package process

import (
	"fmt"
	"os/exec"
	"sync"
	"syscall"
)

// Status represents the current state of a managed child process.
type Status string

const (
	StatusRunning Status = "running"
	StatusStopped Status = "stopped"
)

// ProcInfo holds metadata about a managed child process.
type ProcInfo struct {
	Name   string
	PID    int
	Cmd    *exec.Cmd
	Status Status
}

// Manager tracks and controls child processes.
type Manager struct {
	mu    sync.Mutex
	procs map[string]*ProcInfo
}

// NewManager creates a new process manager.
func NewManager() *Manager {
	return &Manager{
		procs: make(map[string]*ProcInfo),
	}
}

// Spawn starts a child process and tracks it by name.
// Returns an error if a process with the same name is already running
// or if cmd is nil.
func (m *Manager) Spawn(name string, cmd *exec.Cmd) error {
	if cmd == nil {
		return fmt.Errorf("cmd must not be nil")
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.procs[name]; ok && existing.Status == StatusRunning {
		return fmt.Errorf("process %s is already running (PID %d)", name, existing.PID)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start %s: %w", name, err)
	}

	m.procs[name] = &ProcInfo{
		Name:   name,
		PID:    cmd.Process.Pid,
		Cmd:    cmd,
		Status: StatusRunning,
	}

	// Background goroutine to reap the process when it exits
	go func(name string, cmd *exec.Cmd) {
		cmd.Wait()
		m.mu.Lock()
		if proc, ok := m.procs[name]; ok {
			proc.Status = StatusStopped
		}
		m.mu.Unlock()
	}(name, cmd)

	return nil
}

// Kill sends SIGTERM to a named process and marks it as stopped.
// Returns an error if the process doesn't exist or is already stopped.
func (m *Manager) Kill(name string) error {
	m.mu.Lock()
	proc, ok := m.procs[name]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("process %s not found", name)
	}
	m.mu.Unlock()

	if proc.Cmd.Process == nil {
		return fmt.Errorf("process %s has no OS process", name)
	}

	// Send SIGTERM to the process group if Setpgid was set
	if proc.Cmd.SysProcAttr != nil && proc.Cmd.SysProcAttr.Setpgid {
		syscall.Kill(-proc.PID, syscall.SIGTERM)
	} else {
		proc.Cmd.Process.Signal(syscall.SIGTERM)
	}

	m.mu.Lock()
	proc.Status = StatusStopped
	m.mu.Unlock()

	return nil
}

// Get returns the process info for a named process.
func (m *Manager) Get(name string) (*ProcInfo, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	proc, ok := m.procs[name]
	return proc, ok
}

// List returns all tracked processes.
func (m *Manager) List() []*ProcInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	procs := make([]*ProcInfo, 0, len(m.procs))
	for _, p := range m.procs {
		procs = append(procs, p)
	}
	return procs
}

// StopAll sends SIGTERM to all running processes and returns any errors.
func (m *Manager) StopAll() []error {
	m.mu.Lock()
	names := make([]string, 0, len(m.procs))
	for name := range m.procs {
		names = append(names, name)
	}
	m.mu.Unlock()

	var errs []error
	for _, name := range names {
		if err := m.Kill(name); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", name, err))
		}
	}
	return errs
}
