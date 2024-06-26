import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Button, Frog, parseEther } from "frog";
import { devtools } from "frog/dev";
import axios from "axios";
import { FarcasterResponse, OnChainTransaction } from "./interface";
import { errorScreen, infoScreen } from "./middleware";
import dotenv from "dotenv";
import { mintProcess } from "./mint";
import { db } from "./utils/db";
import { provider } from "./utils/eas";
import { createSystem } from "frog/ui";
dotenv.config();

const { Image } = createSystem();

export const app = new Frog({});
const port = process.env.PORT || 5000;
console.log(provider.getTransaction);
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

          returnedText = `Validate with AI Vision`;
          buttons = [
            <Button value="CAST_PROGRESS">Validate with AI vision</Button>,
          ];
          returnObj = {
            intents: buttons,
            action: `/vision/${emitObject.jobId}`,
            image: (
              <Image
                src={embedWithImage.url}
                objectFit="contain"
                width={"256"}
                height={"256"}
              />
            ),
          };
        }

        return c.res(returnObj);
      }
      default: {
        return c.res(
          infoScreen("Press button to display your reply to this cast", [
            <Button value="CAST_TEXT">Fetch image</Button>,
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

app.frame("/vision/:validationId", async (c) => {
  try {
    const { validationId } = c.req.param();
    const returnedText = `Validating cast...`;
    const buttons = [<Button value="CAST_PROGRESS">Continue</Button>];
    const returnObj = {
      ...infoScreen(returnedText, buttons),
      action: `/validations/${validationId}`,
    };
    return c.res(returnObj);
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
    const { validationId } = c.req.param();
    const tx = await provider.getTransaction(
      c.transactionId || c.buttonValue || `0x`
    );

    if (!tx) {
      const buttons = [<Button value={c.transactionId}>Check progress</Button>];
      const returnObj = {
        ...infoScreen("Completing transaction...", buttons),
        action: `/payments/${validationId}`,
      };
      return c.res(returnObj);
    }

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
    const buttons = [<Button value="REFRESH">Continue</Button>];
    const returnObj = {
      ...infoScreen("Success, time to start minting EAS", buttons),
      action: `/jobs/${validationId}`,
    };
    return c.res(returnObj);
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
          Create Proof ⚡
        </Button.Transaction>,
      ];
      const returnObj = {
        ...infoScreen(
          `Validation successful!\n Attest to your image with an onchain EAS Proof, and receive a 33 $degen rebate on the Degen L3. 0.00088 Base ETH fee is required.`,
          buttons
        ),
        action: `/payments/${validationId}`,
      };
      return c.res(returnObj);
    }

    const buttons = [<Button value="REFRESH">Check progress</Button>];
    const returnObj = {
      ...infoScreen("Still validating...", buttons),
      action: `/validations/${validationId}`,
    };
    return c.res(returnObj);
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
    value: parseEther("0.00088"),
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
        infoScreen(
          `Attestation validated! Your Proof has been created onchain on Base. \n\n
        $degen gained! Your image Proof has earned you $degen on the L3`,
          [
            <Button.Reset>Reset Frame</Button.Reset>,
            <Button.Link href={attestation.degenTx}>View $degen</Button.Link>,
            <Button.Link href={attestation.tx}>View EAS Proof</Button.Link>,
          ]
        )
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
