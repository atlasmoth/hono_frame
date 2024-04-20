import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Button, Frog, parseEther } from "frog";
import { devtools } from "frog/dev";
import axios from "axios";
import { FarcasterResponse } from "./interface";
import { errorScreen, infoScreen } from "./middleware";
import dotenv from "dotenv";
import { IMAGE_LINKS_REGEX } from "./utils/misc";
import { mintProcess } from "./mint";
import { db } from "./utils/db";
import { provider } from "./utils/eas";
dotenv.config();

export const app = new Frog({});
const port = process.env.PORT || 5000;

app.use("/*", serveStatic({ root: "./public" }));

app.frame("/", async (c) => {
  try {
    const { status, frameData } = c;
    switch (status) {
      case "response": {
        const url = `https://api.neynar.com/v2/farcaster/cast/conversation?identifier=${frameData?.castId?.hash}&type=hash&reply_depth=1&include_chronological_parent_casts=false`;
        const headers = {
          accept: "application/json",
          api_key: process.env.NEYNAR_API_KEY,
        };
        const {
          data: { conversation },
        } = await axios.get<FarcasterResponse>(url, { headers });
        const [firstSortedAndFilteredReply] = conversation?.cast?.direct_replies
          .map((t) => ({
            ...t,
            date: new Date(t.timestamp),
          }))
          .sort((a: any, b: any) => b?.date - a?.date)
          .filter((a) => Number(a.author.fid) === Number(frameData?.fid));

        if (!firstSortedAndFilteredReply?.text) {
          throw new Error("Please reply to this cast first");
        }
        let returnedText = firstSortedAndFilteredReply.text;
        const [embedWithImage] = firstSortedAndFilteredReply.embeds.filter(
          // (t) => new RegExp(IMAGE_LINKS_REGEX).test(t.url)
          (t) => t.url
        );
        let buttons: any[] = [<Button.Reset>Reset</Button.Reset>];
        let returnObj: any = infoScreen(returnedText, buttons);
        if (embedWithImage) {
          const emitObject = {
            castHash: firstSortedAndFilteredReply.hash,
            userFid: String(frameData?.fid),
            text: returnedText,
            image: embedWithImage.url,
            label: "Testing",
            jobId: Math.random().toString().slice(-15) + Date.now(),
          };

          mintProcess.emit("START_VALIDATING", JSON.stringify(emitObject));

          returnedText = `Validating cast...`;
          buttons = [<Button value="CAST_PROGRESS">Check progress</Button>];
          returnObj = {
            ...infoScreen(returnedText, buttons),
            action: `/validations/${emitObject.jobId}`,
          };
        }

        return c.res(returnObj);
      }
      default: {
        return c.res(
          infoScreen("Press button to display your reply to this cast", [
            <Button value="CAST_TEXT">Fetch text</Button>,
          ])
        );
      }
    }
  } catch (error: any) {
    console.log(error);
    return c.res(
      errorScreen(
        error.message.includes("reply") ? error.message : "Something went wrong"
      )
    );
  }
});
app.frame("/payments/:validationId", async (c) => {
  try {
    const transaction = await provider.getTransaction(c.transactionId as any);
    console.log(transaction);

    const { validationId } = c.req.param();
    let { data: attestation } = await db
      .from("validations")
      .select()
      .eq("job_id", validationId)
      .limit(1)
      .single();
    mintProcess.emit(
      "START_MINTING",
      JSON.stringify({
        ...attestation,
        castHash: attestation.cast,
        jobId: attestation.job_id,
        userFid: attestation.fid,
      })
    );
    return {
      ...c.res(
        infoScreen("Success, time to start minting EAS", [
          <Button value="REFRESH">Continue</Button>,
        ])
      ),
      action: `/jobs/${validationId}`,
    };
  } catch (error: any) {
    console.log(error);
    return c.res(
      errorScreen(
        error.message.includes("reply") ? error.message : "Something went wrong"
      )
    );
  }
});
app.frame("/validations/:validationId", async (c) => {
  try {
    const { validationId } = c.req.param();
    let { data: attestation } = await db
      .from("validations")
      .select()
      .eq("job_id", validationId)
      .limit(1)
      .single();
    if (attestation) {
      const buttons = [
        <Button.Transaction target={`/transactions/${validationId}`}>
          Pay now
        </Button.Transaction>,
      ];
      const returnObj = {
        ...infoScreen("Validation successful, please pay.", buttons),
        action: `/payments/${validationId}`,
      };
      return c.res(returnObj);
    }

    return {
      ...c.res(
        infoScreen("Still validating...", [
          <Button value="REFRESH">Check progress</Button>,
        ])
      ),
      action: `/validations/${validationId}`,
    };
  } catch (error: any) {
    console.log(error);
    return c.res(
      errorScreen(
        error.message.includes("reply") ? error.message : "Something went wrong"
      )
    );
  }
});
app.transaction("/transactions/:transactionId", (c) => {
  return c.send({
    // chainId: "eip155:666666666",
    chainId: "eip155:84532",
    to: "0xd9f2D8DA9c8Ff285080FE0Df6285F3551bf1397b",
    value: parseEther("0.0001"),
  });
});
app.frame("/jobs/:jobId", async (c) => {
  try {
    const { jobId } = c.req.param();
    let { data: attestation } = await db
      .from("attestations")
      .select()
      .eq("job_id", jobId)
      .limit(1)
      .single();
    if (attestation && attestation.is_valid && attestation.tx) {
      return c.res(
        infoScreen(attestation.tx, [
          <Button.Reset>Reset</Button.Reset>,
          <Button.Link href={attestation.tx}>View</Button.Link>,
        ])
      );
    }
    if (attestation && attestation.message) {
      return c.res(
        infoScreen(attestation.message, [<Button.Reset>Reset</Button.Reset>])
      );
    }

    return {
      ...c.res(
        infoScreen("\n\n\nStill loading...", [
          <Button value="REFRESH">Check status</Button>,
        ])
      ),
      action: `/jobs/${jobId}`,
    };
  } catch (error: any) {
    console.log(error);
    return c.res(
      errorScreen(
        error.message.includes("reply") ? error.message : "Something went wrong"
      )
    );
  }
});

devtools(app, { serveStatic });

serve({
  fetch: app.fetch,
  port: Number(port),
});

console.log(`Server listening on ${port}`);
