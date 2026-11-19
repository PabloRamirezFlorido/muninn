// procwatch: vigila si hay procesos con ciertos nombres abiertos, con muy poco consumo.
//
// Protocolo (líneas UTF-8):
//   stdin  "watch a.exe,b.exe"  -> fija los ejecutables a vigilar (sustituye la lista anterior)
//   stdout "running a.exe"      -> los vigilados que están abiertos ahora (vacío = ninguno);
//                                  solo se escribe cuando cambia el conjunto.
// Termina solo cuando se cierra su stdin (es decir, cuando se cierra Muninn).
//
// Compilar: csc /nologo /optimize /target:exe /out:procwatch.exe procwatch.cs
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;

static class ProcWatch
{
    static readonly object Gate = new object();
    static HashSet<string> watched = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    static string last = null;

    static void Main()
    {
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        var reader = new Thread(() =>
        {
            var stdin = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                if (!line.StartsWith("watch ")) continue;
                var names = line.Substring(6).Split(',')
                    .Select(n => n.Trim())
                    .Where(n => n.Length > 0)
                    .Select(n => n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? n.Substring(0, n.Length - 4) : n);
                lock (Gate) { watched = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase); last = null; }
            }
            Environment.Exit(0);
        }) { IsBackground = true };
        reader.Start();

        while (true)
        {
            HashSet<string> current;
            lock (Gate) current = watched;
            if (current.Count > 0)
            {
                var found = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var p in Process.GetProcesses())
                {
                    try { if (current.Contains(p.ProcessName)) found.Add(p.ProcessName + ".exe"); }
                    catch { /* proceso cerrado mientras se leía */ }
                    finally { p.Dispose(); }
                }
                var msg = "running " + string.Join(",", found).ToLowerInvariant();
                lock (Gate)
                {
                    if (msg != last) { last = msg; stdout.WriteLine(msg); }
                }
            }
            Thread.Sleep(2000);
        }
    }
}
