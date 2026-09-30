// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.7.0 <0.9.0;

contract SolvencyGroth16Verifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20795459224953934783102106448420082608387164135129622007722732251725760683579;
    uint256 constant alphay  = 7858142057181239145590182775411756382129286418781276092603913632768968071483;
    uint256 constant betax1  = 100661932550428604442085675774287542675969638500510427824597785153534208542;
    uint256 constant betax2  = 21254854275528387360942998913594953300314036800177471800242605472386845837230;
    uint256 constant betay1  = 5087321408538359800246974194573793604891364142828477529783293233183020786275;
    uint256 constant betay2  = 20228133443620650965642919875720595454510237513715795510137155996338469708340;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 4769734658581622657695796223607674425910819483591125162382409531246090570375;
    uint256 constant deltax2 = 9597638644448660489347371434650559378322302810116515826586654155641458788003;
    uint256 constant deltay1 = 7364334226291762046951385270437064948455780204625751498655479970800220078546;
    uint256 constant deltay2 = 17182825966065284337234449891787498738203529469241710280782705341619656481573;

    
    uint256 constant IC0x = 20217415904385727865270568441922147795062029057629608899235295963011220791583;
    uint256 constant IC0y = 7765257334321347483861398409616869990836156949374483234726982800981281844039;
    
    uint256 constant IC1x = 20833037243955224728743019951752734113944888019768089161191353962955587662223;
    uint256 constant IC1y = 17888776988891307858262832246094424698935453523432164229108987369866037421797;
    
    uint256 constant IC2x = 21263999753770461316830038120512888461687728175236355662750755842922402509269;
    uint256 constant IC2y = 4921926883281738819836876390235523966235615652631300877941436575922661394626;
    
    uint256 constant IC3x = 10096666382558671925757902244959993271839011247990020459773263920835728815669;
    uint256 constant IC3y = 20680955343025789764558743259166948531284310655027083762165056216336422903875;
    
    uint256 constant IC4x = 8454564701936521336611325761572720131769498095580746893184708530901695912529;
    uint256 constant IC4y = 18424851520463547371095003229120460509046338737955804607922993927355353527550;
    

    function verifyProof(
        uint[2] calldata a,
        uint[2][2] calldata b,
        uint[2] calldata c,
        uint[4] calldata input
    ) public view returns (bool ok) {
        uint256[2] memory memoryInput;
        uint256[2] memory vk_x;

        vk_x[0] = IC0x;
        vk_x[1] = IC0y;

        for (uint i = 0; i < input.length; i++) {
            if (input[i] >= r) return false;
        }

        memoryInput[0] = IC1x;
        memoryInput[1] = IC1y;
        vk_x = addition(vk_x, scalar_mul(memoryInput, input[0]));

        memoryInput[0] = IC2x;
        memoryInput[1] = IC2y;
        vk_x = addition(vk_x, scalar_mul(memoryInput, input[1]));

        memoryInput[0] = IC3x;
        memoryInput[1] = IC3y;
        vk_x = addition(vk_x, scalar_mul(memoryInput, input[2]));

        memoryInput[0] = IC4x;
        memoryInput[1] = IC4y;
        vk_x = addition(vk_x, scalar_mul(memoryInput, input[3]));


        vk_x = addition(vk_x, [alphax, alphay]);

        return pairing(
            [a[0], a[1]],
            [[b[0][1], b[0][0]], [b[1][1], b[1][0]]],
            [vk_x[0], vk_x[1]],
            [[gammax2, gammax1], [gammay2, gammay1]],
            [c[0], c[1]],
            [[deltax2, deltax1], [deltay2, deltay1]]
        );
    }

    function scalar_mul(uint256[2] memory pt, uint256 scalar) internal view returns (uint256[2] memory result) {
        uint256[3] memory input;
        input[0] = pt[0];
        input[1] = pt[1];
        input[2] = scalar;

        bool success;
        assembly {
            success := staticcall(sub(gas(), 2000), 7, input, 0x60, result, 0x40)
        }
        require(success);
    }

    function addition(uint256[2] memory pt1, uint256[2] memory pt2) internal view returns (uint256[2] memory result) {
        uint256[4] memory input;
        input[0] = pt1[0];
        input[1] = pt1[1];
        input[2] = pt2[0];
        input[3] = pt2[1];

        bool success;
        assembly {
            success := staticcall(sub(gas(), 2000), 6, input, 0x80, result, 0x40)
        }
        require(success);
    }

    function pairing(
        uint256[2] memory a1,
        uint256[2][2] memory a2,
        uint256[2] memory b1,
        uint256[2][2] memory b2,
        uint256[2] memory c1,
        uint256[2][2] memory c2
    ) internal view returns (bool) {
        uint256[24] memory input;

        input[0] = a1[0];
        input[1] = a1[1];
        input[2] = a2[0][0];
        input[3] = a2[0][1];
        input[4] = a2[1][0];
        input[5] = a2[1][1];

        input[6] = b1[0];
        input[7] = b1[1];
        input[8] = b2[0][0];
        input[9] = b2[0][1];
        input[10] = b2[1][0];
        input[11] = b2[1][1];

        input[12] = c1[0];
        input[13] = c1[1];
        input[14] = c2[0][0];
        input[15] = c2[0][1];
        input[16] = c2[1][0];
        input[17] = c2[1][1];

        // Negate deltax / deltay for Groth16 equation check
        // Or directly call alt_bn128 pairing check
        uint256[2] memory negC1;
        negC1[0] = c1[0];
        negC1[1] = q - (c1[1] % q);

        input[12] = negC1[0];
        input[13] = negC1[1];

        uint256[1] memory out;
        bool success;
        assembly {
            success := staticcall(sub(gas(), 2000), 8, input, 0x300, out, 0x20)
        }
        require(success);
        return out[0] != 0;
    }
}
