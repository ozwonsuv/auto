param(
  [int]$Port = 8765,
  [string]$Root = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}
else {
  $Root = [System.IO.Path]::GetFullPath($Root)
}

$mimeTypes = @{
  '.css' = 'text/css; charset=utf-8'
  '.html' = 'text/html; charset=utf-8'
  '.js' = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.md' = 'text/markdown; charset=utf-8'
  '.txt' = 'text/plain; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Output "Serving $Root at http://127.0.0.1:$Port/"

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    try {
      $relativePath = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath).TrimStart('/')
      if ([string]::IsNullOrWhiteSpace($relativePath)) {
        $relativePath = 'index.html'
      }

      $requestedPath = [System.IO.Path]::GetFullPath((Join-Path $Root $relativePath.Replace('/', '\')))
      if (-not $requestedPath.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
        $context.Response.StatusCode = 403
      }
      elseif (-not (Test-Path -LiteralPath $requestedPath -PathType Leaf)) {
        $context.Response.StatusCode = 404
      }
      else {
        $bytes = [System.IO.File]::ReadAllBytes($requestedPath)
        $extension = [System.IO.Path]::GetExtension($requestedPath).ToLowerInvariant()
        $context.Response.ContentType = if ($mimeTypes.ContainsKey($extension)) {
          $mimeTypes[$extension]
        }
        else {
          'application/octet-stream'
        }
        $context.Response.StatusCode = 200
        $context.Response.ContentLength64 = $bytes.Length
        $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      }
    }
    catch {
      $context.Response.StatusCode = 500
    }
    finally {
      $context.Response.OutputStream.Close()
    }
  }
}
finally {
  $listener.Stop()
  $listener.Close()
}
