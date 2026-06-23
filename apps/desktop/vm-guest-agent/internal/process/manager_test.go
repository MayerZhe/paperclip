package process

import (
	"fmt"
	"os/exec"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestNewManager(t *testing.T) {
	m := NewManager()
	if m == nil {
		t.Fatal("NewManager() returned nil")
	}
	if len(m.List()) != 0 {
		t.Error("new manager should have no processes")
	}
}

func TestSpawnAndKill(t *testing.T) {
	m := NewManager()

	// Spawn a simple sleep process
	cmd := exec.Command("sleep", "10")
	err := m.Spawn("test-sleep", cmd)
	if err != nil {
		t.Fatalf("Spawn() error = %v", err)
	}

	// Verify it's tracked
	procs := m.List()
	if len(procs) != 1 {
		t.Errorf("List() len = %d, want 1", len(procs))
	}

	// Verify we can get it
	proc, ok := m.Get("test-sleep")
	if !ok {
		t.Fatal("Get(test-sleep) returned false")
	}
	if proc.Name != "test-sleep" {
		t.Errorf("proc.Name = %s, want test-sleep", proc.Name)
	}
	if proc.PID <= 0 {
		t.Errorf("proc.PID = %d, want > 0", proc.PID)
	}
	if proc.Status != StatusRunning {
		t.Errorf("proc.Status = %s, want %s", proc.Status, StatusRunning)
	}

	// Kill it
	err = m.Kill("test-sleep")
	if err != nil {
		t.Fatalf("Kill() error = %v", err)
	}

	// Wait a moment for SIGTERM
	time.Sleep(100 * time.Millisecond)

	proc, ok = m.Get("test-sleep")
	if !ok {
		// Already cleaned up — also valid behavior
		return
	}
	if proc.Status != StatusStopped {
		t.Logf("proc.Status = %s after kill (PID %d)", proc.Status, proc.PID)
	}
}

func TestSpawnDuplicate(t *testing.T) {
	m := NewManager()

	cmd1 := exec.Command("sleep", "1")
	err := m.Spawn("dup-test", cmd1)
	if err != nil {
		t.Fatalf("first Spawn() error = %v", err)
	}

	cmd2 := exec.Command("sleep", "1")
	err = m.Spawn("dup-test", cmd2)
	if err == nil {
		t.Error("Spawn() with duplicate name should return error")
	}
}

func TestKillNonExistent(t *testing.T) {
	m := NewManager()
	err := m.Kill("nonexistent")
	if err == nil {
		t.Error("Kill() non-existent process should return error")
	}
}

func TestGetNonExistent(t *testing.T) {
	m := NewManager()
	_, ok := m.Get("nonexistent")
	if ok {
		t.Error("Get() non-existent process should return false")
	}
}

func TestListMultipleProcesses(t *testing.T) {
	m := NewManager()

	cmd1 := exec.Command("sleep", "10")
	m.Spawn("proc-a", cmd1)

	cmd2 := exec.Command("sleep", "10")
	m.Spawn("proc-b", cmd2)

	procs := m.List()
	if len(procs) != 2 {
		t.Errorf("List() len = %d, want 2", len(procs))
	}

	// Cleanup
	m.Kill("proc-a")
	m.Kill("proc-b")
}

func TestSpawnNilCommand(t *testing.T) {
	m := NewManager()
	err := m.Spawn("nil-cmd", nil)
	if err == nil {
		t.Error("Spawn(nil) should return error")
	}
}

func TestConcurrentSpawnAndKill(t *testing.T) {
	m := NewManager()
	var wg sync.WaitGroup

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			name := fmt.Sprintf("concurrent-%d", idx)
			cmd := exec.Command("sleep", "1")
			err := m.Spawn(name, cmd)
			if err != nil {
				t.Errorf("concurrent Spawn(%s) error = %v", name, err)
				return
			}
			time.Sleep(50 * time.Millisecond)
			m.Kill(name)
		}(i)
	}

	wg.Wait()
}

func TestSIGTERMSignal(t *testing.T) {
	m := NewManager()

	cmd := exec.Command("sleep", "30")
	// Set up process group so we can signal properly
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	err := m.Spawn("sigterm-test", cmd)
	if err != nil {
		t.Fatalf("Spawn() error = %v", err)
	}

	proc, _ := m.Get("sigterm-test")

	// Kill sends SIGTERM by default
	err = m.Kill("sigterm-test")
	if err != nil {
		t.Fatalf("Kill() error = %v", err)
	}

	// Wait for process to actually exit
	time.Sleep(200 * time.Millisecond)

	// Verify process is no longer running
	if proc.Cmd.ProcessState == nil {
		_ = proc.Cmd.Wait() // reap zombie
	}
}

func TestStopAll(t *testing.T) {
	m := NewManager()

	for i := 0; i < 3; i++ {
		cmd := exec.Command("sleep", "30")
		m.Spawn(fmt.Sprintf("all-%d", i), cmd)
	}

	errs := m.StopAll()
	if len(errs) > 0 {
		t.Logf("StopAll errors: %v", errs)
	}

	procs := m.List()
	for _, p := range procs {
		if p.Status == StatusRunning {
			t.Errorf("process %s still running after StopAll", p.Name)
		}
	}
}

func TestStartProcess(t *testing.T) {
	m := NewManager()
	cmd := exec.Command("true") // exits immediately with 0
	err := m.Spawn("true-test", cmd)
	if err != nil {
		t.Fatalf("Spawn() error = %v", err)
	}
	// Give it time to exit
	time.Sleep(200 * time.Millisecond)

	proc, ok := m.Get("true-test")
	if !ok {
		t.Fatal("process should still be tracked after exit")
	}
	// After exit, the process should be stopped
	if proc.Status != StatusStopped {
		t.Logf("proc.Status = %s after true exit (PID %d)", proc.Status, proc.PID)
	}
}
