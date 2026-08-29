# Invented block workbench

**Invented.** A working note with runnable blocks in it, for §7 F1. Nothing here
touches real data — the numbers are made up in the block itself.

Nothing on this page runs on its own. Opening the note runs nothing, loading the
vault runs nothing (rule 12). A block runs when you press **Run** and confirm the
dialog that shows you the code first.

## Python — prints and draws

Prints, and draws a figure. The figure is captured by the harness with the `Agg`
backend, saved into the runs folder, and embedded under the block.

```python
import statistics
import matplotlib.pyplot as plt

stays = [3, 5, 2, 9, 4, 6, 3, 11, 2, 7]
print("n =", len(stays))
print("median length of stay:", statistics.median(stays), "days")

plt.figure(figsize=(6, 3))
plt.hist(stays, bins=range(1, 13), edgecolor="white")
plt.title("Invented length of stay")
plt.xlabel("days")
plt.ylabel("patients")

statistics.mean(stays)
```

The bare `statistics.mean(stays)` on the last line prints its value without a
`print`, the way a notebook cell does. Only the **last** expression is
displayed. An earlier draft displayed every one, like a REPL, and a block that
drew a chart then printed five lines of matplotlib repr around two lines of
output.

## Python — fails on purpose

For the error path: the traceback should name **this** note's line numbers, not
the harness's, and the run record should say `exit: error`.

```python
totals = {"echo": 41, "admissions": 88}
print("known extracts:", sorted(totals))
print(totals["catheter"])
```

## R — prints, warns and draws

For the R harness. The warning must **not** stop the block: an aborted run over
a cosmetic warning would be forty lines that silently never ran.

```r
stays <- c(3, 5, 2, 9, 4, 6, 3, 11, 2, 7)
cat("n =", length(stays), "\n")

median(stays)

warning("this warning must not stop the block")
cat("still running after the warning\n")

plot(stays, type = "b", main = "Invented length of stay", xlab = "case", ylab = "days")
```

## R — fails on purpose

The error should name the line **in this note** where it happened.

```r
counts <- c(echo = 41, admissions = 88)
print(counts)
stop("deliberate failure, to see how it is recorded")
```

## Never run this one

Fenced `no-run`, so no Run button appears and the palette does not offer it.
The flag exists for the block that is an illustration of what *not* to do —
a real thing to write in an SOP.

```python no-run
import shutil
shutil.rmtree("everything")
```
