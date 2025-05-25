import { HonoRequest } from "hono";


export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "3600",
};


const requiredHeaders = {
  "Accept": "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-US,en;q=0.5",
  "origin": "https://megacloud.tv",  
  "Referer": "https://megacloud.tv/",  
  "Sec-Ch-Ua": "\"Chromium\";v=\"134\", \"Not:A-Brand\";v=\"24\", \"Brave\";v=\"134\"",
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": "\"Windows\"",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "cross-site",
  "Sec-Gpc": "1",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
};

export async function RequestHandler({ response }: { response: HonoRequest }) {
  try {
    const { url, ref } = response.query();
    
    if (!url) {
      return new Response(JSON.stringify({ error: "No URL provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    const targetURL = new URL(url);
    const targetHost = targetURL.hostname;
    
    const headers = { ...requiredHeaders };
    
   
    
   //console.log("Fetching URL:", url);
   // console.log("Using headers:", headers);

    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

   
    const fetchOptions = {
      headers,
      redirect: "follow",
      signal: controller.signal,
      method: "GET"
    };

    const fetchedResponse = await fetch(url, fetchOptions)
      .finally(() => clearTimeout(timeoutId));

    //console.log("Response status:", fetchedResponse.status);
    
    if (fetchedResponse.status === 403) {
      console.error("403 Forbidden - Server denied access");
      return new Response(
        JSON.stringify({ 
          message: "Access denied by target server", 
          error: "The streaming server returned a 403 Forbidden error",
          headers: headers 
        }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          },
        }
      );
    }

    let type = fetchedResponse.headers.get("Content-Type") || "text/plain";
    let responseBody: ArrayBuffer | string | null = null;
    //console.log("Content type:", type);

   
    if (type.includes("text/vtt")) {
     // console.log("VTT file found");
      responseBody = (await fetchedResponse.text()) as string;

      const regex = /.+?\.(jpg)+/g;
      const matches = [...responseBody.matchAll(regex)];

      let fileNames: string[] = [];
    
      for (const match of matches) {
        const filename = match[0];
        if (!fileNames.includes(filename)) {
          fileNames.push(filename);
        }
      }

      if (fileNames.length > 0) {
        for (const filename of fileNames) {
          const newUrl = url.replace(/\/[^\/]*$/, `/${filename}`);
        
          responseBody = responseBody.replaceAll(
            filename,
            "/fetch?url=" + encodeURIComponent(newUrl)
          );
        }
      }
    } else if (
      type.includes("application/vnd.apple.mpegurl") ||
      type.includes("application/x-mpegurl") ||
      type.includes("video/MP2T") ||
      type.includes("audio/mpegurl") ||
      type.includes("application/x-mpegURL") ||
      type.includes("audio/x-mpegurl") ||
      (type.includes("text/html") && 
        (url.endsWith(".m3u8") || url.endsWith(".ts"))) 
    ) {
      responseBody = (await fetchedResponse.text()) as string;

      if (!responseBody.startsWith("#EXTM3U")) {
        return new Response(responseBody, {
          headers: corsHeaders,
          status: fetchedResponse.status,
          statusText: fetchedResponse.statusText,
        });
      }

     // console.log("HLS stream found");

      const regex = /\/[^\/]*$/;
      const urlRegex = /^(?:(?:(?:https?|ftp):)?\/\/)[^\s/$.?#].[^\s]*$/i;
      const m3u8FileChunks = responseBody.split("\n");
      const m3u8AdjustedChunks = [];

      for (const line of m3u8FileChunks) {
        if (line.startsWith("#") || !line.trim()) {
          m3u8AdjustedChunks.push(line);
          continue;
        }

        let formattedLine = line;
        if (line.startsWith(".")) {
          formattedLine = line.substring(1); 
        }

        if (formattedLine.match(urlRegex)) {
          //console.log("TS or M3U8 files with URLs found, adding proxy path");
         
          m3u8AdjustedChunks.push(
            `/fetch?url=${encodeURIComponent(formattedLine)}`
          );
        } else {
          const newUrls = url.replace(
            regex,
            formattedLine.startsWith("/") ? formattedLine : `/${formattedLine}`
          );
          //console.log("TS or M3U8 files with no URLs found, adding path and proxy path.");
      
          m3u8AdjustedChunks.push(
            `/fetch?url=${encodeURIComponent(newUrls)}`
          );
        }
      }

      responseBody = m3u8AdjustedChunks.join("\n");
    } else {
      responseBody = await fetchedResponse.arrayBuffer();
    }

    if (responseBody instanceof ArrayBuffer) {
      const body = new Uint8Array(responseBody);
      if (body.length > 0 && body[0] === 0x47) {
        //console.log("disguised files found");
        type = "video/mp2t";
      }
    }

    
    const responseHeaders = { ...corsHeaders, "Content-Type": type };

    return new Response(responseBody, {
      headers: responseHeaders,
      status: fetchedResponse.status,
      statusText: fetchedResponse.statusText,
    });
  } catch (error: any) {
    console.error("Proxy error:", error);
    

    let errorMessage = error.message;
    let statusCode = 500;
    
    if (error.name === "AbortError") {
      errorMessage = "Request timed out";
      statusCode = 504;
    } else if (error.name === "TypeError" && error.message.includes("fetch")) {
      errorMessage = "Network error when trying to fetch resource";
      statusCode = 502;
    }

    return new Response(
      JSON.stringify({ 
        message: "Request failed", 
        error: errorMessage,
        url: response.query().url 
      }),
      {
        status: statusCode,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        },
      }
    );
  }
}
